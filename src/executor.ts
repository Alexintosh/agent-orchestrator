import type { OrchestratorStore } from "./interfaces/store.js";
import type { WorkspaceResolver } from "./interfaces/workspace.js";
import type { AuthProvider } from "./interfaces/auth.js";
import type { RunLogger, RunLogHandle, Logger } from "./interfaces/logger.js";
import type { OrchestratorEventEmitter } from "./interfaces/events.js";
import type {
  Run,
  AdapterExecutionResult,
  AdapterInvocationMeta,
  ServerAdapterModule,
} from "./types.js";
import {
  resolveNextSessionState,
  normalizeUsageTotals,
  deriveTaskKey,
  shouldResetTaskSessionForWake,
  defaultSessionCodec,
  parseSessionCompactionPolicy,
} from "./session.js";
import { parseObject, appendWithCap, MAX_EXCERPT_BYTES } from "./adapters/_shared/utils.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

export interface ExecutorDeps {
  store: OrchestratorStore;
  getAdapter: (type: string) => ServerAdapterModule;
  workspace: WorkspaceResolver;
  auth: AuthProvider;
  runLogger: RunLogger;
  logger: Logger;
  events: OrchestratorEventEmitter;
}

/**
 * Core run executor — the 15-step orchestration flow.
 * Adapted from Paperclip's heartbeat.ts executeRun().
 *
 * Steps:
 * 1. Claim run (queued → running)
 * 2. Resolve agent
 * 3. Resolve task key
 * 4. Resolve workspace
 * 5. Resolve session (load previous, check compaction)
 * 6. Resolve adapter config
 * 7. Realize workspace (create dirs)
 * 8. Generate auth token
 * 9. Dispatch to adapter
 * 10. Process result
 * 11. Persist session
 * 12. Record costs
 * 13. Update runtime state
 * 14. Release locks
 * 15. Finalize
 */
export async function executeRun(
  runId: string,
  deps: ExecutorDeps,
): Promise<AdapterExecutionResult | null> {
  const { store, getAdapter, workspace, auth, runLogger, logger, events } = deps;

  // Step 1: Claim the run
  let run = await store.getRun(runId);
  if (!run) return null;
  if (run.status !== "queued" && run.status !== "running") return null;

  if (run.status === "queued") {
    const claimed = await store.claimRun(runId);
    if (!claimed) return null;
    run = claimed;
  }

  events.emit("run.started", run);

  let handle: RunLogHandle | null = null;
  let stdoutExcerpt = "";
  let stderrExcerpt = "";

  try {
    // Step 2: Resolve agent
    const agent = await store.getAgent(run.agentId);
    if (!agent) {
      await store.updateRun(runId, {
        status: "failed",
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      return null;
    }

    // Ensure runtime state exists for this agent
    await store.ensureRuntimeState(agent.id, agent.tenantId, agent.adapterType);

    // Step 3: Resolve task key
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKey(context, null);

    // Step 4: Resolve adapter and session codec
    const adapter = getAdapter(agent.adapterType);
    const sessionCodec = adapter.sessionCodec ?? defaultSessionCodec;

    // Step 5: Resolve session
    const resetSession = shouldResetTaskSessionForWake(context);
    const taskSession =
      taskKey && !resetSession
        ? await store.getTaskSession(
            agent.tenantId,
            agent.id,
            agent.adapterType,
            taskKey,
          )
        : null;

    const previousSessionParams = taskSession?.sessionParamsJson
      ? sessionCodec.deserialize(taskSession.sessionParamsJson)
      : null;

    // Evaluate session compaction
    const compactionPolicy = parseSessionCompactionPolicy(
      agent.adapterType,
      agent.runtimeConfig,
    );
    const previousSessionDisplayId = taskSession?.sessionDisplayId ?? null;
    let runtimeSessionId = readNonEmptyString(previousSessionParams?.sessionId);
    let runtimeSessionParams = previousSessionParams;
    let sessionRotated = false;
    let sessionRotationReason: string | null = null;

    if (
      compactionPolicy.enabled &&
      taskSession &&
      runtimeSessionId
    ) {
      const shouldRotate =
        taskSession.runCount >= compactionPolicy.maxSessionRuns ||
        taskSession.totalRawInputTokens >= compactionPolicy.maxRawInputTokens;

      if (shouldRotate) {
        sessionRotated = true;
        sessionRotationReason = taskSession.runCount >= compactionPolicy.maxSessionRuns
          ? `session run count (${taskSession.runCount}) exceeds limit (${compactionPolicy.maxSessionRuns})`
          : `session token usage (${taskSession.totalRawInputTokens}) exceeds limit (${compactionPolicy.maxRawInputTokens})`;
        runtimeSessionId = null;
        runtimeSessionParams = null;
        events.emit("session.rotated", agent.id, taskKey ?? "", sessionRotationReason);
      }
    }

    // Step 6: Resolve config
    const resolvedConfig = parseObject(agent.adapterConfig);

    // Step 7: Realize workspace
    const resolvedWorkspace = await workspace.resolve(agent, {
      taskKey,
      contextSnapshot: context,
      sessionCwd: readNonEmptyString(previousSessionParams?.cwd),
    });
    const cwd = await workspace.realize(resolvedWorkspace);

    // Update context with workspace info
    context.workspace = {
      cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    };

    // Step 8: Generate auth token
    const authToken = adapter.supportsLocalAgentJwt
      ? auth.createToken(agent, run.id)
      : null;

    // Prepare runtime for adapter
    const runtimeForAdapter = {
      sessionId: runtimeSessionId,
      sessionParams: runtimeSessionParams,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    // Update run with session info
    await store.updateRun(run.id, {
      startedAt: run.startedAt ?? new Date(),
      sessionIdBefore:
        runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
      contextSnapshot: context,
    });

    // Begin run log
    handle = await runLogger.begin({
      tenantId: run.tenantId,
      agentId: run.agentId,
      runId,
    });

    await store.updateRun(run.id, {
      logStore: handle.store,
      logRef: handle.logRef,
    });

    // Build log callback
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stdout")
        stdoutExcerpt = appendExcerpt(stdoutExcerpt, chunk);
      if (stream === "stderr")
        stderrExcerpt = appendExcerpt(stderrExcerpt, chunk);
      const ts = new Date().toISOString();

      if (handle) {
        await runLogger.append(handle, { stream, chunk, ts });
      }
    };

    // Log workspace warnings
    for (const warning of resolvedWorkspace.warnings) {
      await onLog("stderr", `[orchestrator] ${warning}\n`);
    }
    if (resetSession) {
      await onLog(
        "stderr",
        `[orchestrator] Starting fresh session (reset requested)\n`,
      );
    }
    if (sessionRotated && sessionRotationReason) {
      await onLog(
        "stderr",
        `[orchestrator] Starting fresh session: ${sessionRotationReason}\n`,
      );
    }

    const onAdapterMeta = async (_meta: AdapterInvocationMeta) => {
      // Could emit to events or log — kept as hook point
    };

    // Step 9: Dispatch to adapter
    logger.info(
      { runId, agentId: agent.id, adapter: agent.adapterType },
      "dispatching run to adapter",
    );

    const adapterResult = await adapter.execute({
      runId: run.id,
      agent: {
        id: agent.id,
        tenantId: agent.tenantId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      runtime: runtimeForAdapter,
      config: resolvedConfig,
      context,
      onLog,
      onMeta: onAdapterMeta,
      authToken: authToken ?? undefined,
    });

    // Step 10: Process result
    const nextSessionState = resolveNextSessionState({
      codec: sessionCodec,
      adapterResult,
      previousParams: previousSessionParams,
      previousDisplayId: runtimeForAdapter.sessionDisplayId,
      previousLegacySessionId: runtimeForAdapter.sessionId,
    });

    const rawUsage = normalizeUsageTotals(adapterResult.usage);

    let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    const latestRun = await store.getRun(run.id);
    if (latestRun?.status === "cancelled") {
      outcome = "cancelled";
    } else if (adapterResult.timedOut) {
      outcome = "timed_out";
    } else if (
      (adapterResult.exitCode ?? 0) === 0 &&
      !adapterResult.errorMessage
    ) {
      outcome = "succeeded";
    } else {
      outcome = "failed";
    }

    // Finalize log
    let logSummary: {
      bytes: number;
      sha256?: string;
      compressed: boolean;
    } | null = null;
    if (handle) {
      logSummary = await runLogger.finalize(handle);
    }

    const usageJson =
      rawUsage || adapterResult.costUsd != null
        ? ({
            ...(rawUsage ?? {}),
            sessionRotated,
            sessionRotationReason,
            ...(adapterResult.costUsd != null
              ? { costUsd: adapterResult.costUsd }
              : {}),
            ...(adapterResult.billingType
              ? { billingType: adapterResult.billingType }
              : {}),
          } as Record<string, unknown>)
        : null;

    // Step 15: Finalize — update run status
    await store.updateRun(run.id, {
      status: outcome === "succeeded" ? "succeeded" : outcome === "cancelled" ? "cancelled" : outcome === "timed_out" ? "timed_out" : "failed",
      finishedAt: new Date(),
      error:
        outcome === "succeeded"
          ? null
          : (adapterResult.errorMessage ??
            (outcome === "timed_out" ? "Timed out" : "Adapter failed")),
      errorCode:
        outcome === "timed_out"
          ? "timeout"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "failed"
              ? (adapterResult.errorCode ?? "adapter_failed")
              : null,
      exitCode: adapterResult.exitCode,
      signal: adapterResult.signal,
      usageJson,
      resultJson: adapterResult.resultJson ?? null,
      sessionIdAfter:
        nextSessionState.displayId ?? nextSessionState.legacySessionId,
      stdoutExcerpt,
      stderrExcerpt,
      logBytes: logSummary?.bytes ?? null,
      logSha256: logSummary?.sha256 ?? null,
      logCompressed: logSummary?.compressed ?? false,
    });

    // Step 11: Persist session
    if (taskKey) {
      if (
        adapterResult.clearSession ||
        (!nextSessionState.params && !nextSessionState.displayId)
      ) {
        await store.clearTaskSession(agent.id, taskKey);
      } else {
        await store.upsertTaskSession({
          tenantId: agent.tenantId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          taskKey,
          sessionParamsJson: nextSessionState.params,
          sessionDisplayId: nextSessionState.displayId,
          lastRunId: run.id,
          lastError:
            outcome === "succeeded"
              ? null
              : (adapterResult.errorMessage ?? "run_failed"),
        });
      }
    }

    // Step 12: Record costs
    if (rawUsage || adapterResult.costUsd != null) {
      const costCents = adapterResult.costUsd
        ? Math.round(adapterResult.costUsd * 100)
        : 0;
      await store.recordCost({
        tenantId: agent.tenantId,
        agentId: agent.id,
        runId: run.id,
        adapterType: agent.adapterType,
        provider: adapterResult.provider ?? null,
        model: adapterResult.model ?? null,
        billingType: adapterResult.billingType ?? null,
        inputTokens: rawUsage?.inputTokens ?? 0,
        outputTokens: rawUsage?.outputTokens ?? 0,
        cachedInputTokens: rawUsage?.cachedInputTokens ?? 0,
        costUsd: adapterResult.costUsd ?? null,
        costCents,
      });
    }

    // Step 13: Update runtime state
    if (rawUsage) {
      await store.accumulateUsage(agent.id, {
        inputTokens: rawUsage.inputTokens,
        outputTokens: rawUsage.outputTokens,
        cachedInputTokens: rawUsage.cachedInputTokens,
      });
    }

    await store.updateRuntimeState(agent.id, {
      lastRunId: run.id,
      lastRunStatus: outcome,
      sessionId:
        nextSessionState.legacySessionId,
      sessionDisplayId: nextSessionState.displayId,
      sessionParamsJson: nextSessionState.params,
      lastError:
        outcome === "succeeded"
          ? null
          : (adapterResult.errorMessage ?? "run_failed"),
    });

    // Emit completion event
    const finalRun = await store.getRun(run.id);
    if (finalRun) {
      if (outcome === "succeeded" || outcome === "failed") {
        events.emit(
          outcome === "succeeded" ? "run.completed" : "run.failed",
          finalRun,
          outcome === "succeeded"
            ? adapterResult
            : new Error(adapterResult.errorMessage ?? "Adapter failed") as any,
        );
      } else if (outcome === "cancelled") {
        events.emit("run.cancelled", finalRun);
      }
    }

    return adapterResult;
  } catch (err) {
    // Catch-all for setup/execution errors
    const message =
      err instanceof Error ? err.message : "Unknown execution failure";
    logger.error({ err, runId }, "run execution failed");

    if (handle) {
      try {
        await runLogger.finalize(handle);
      } catch {
        // ignore finalize errors
      }
    }

    await store
      .updateRun(runId, {
        status: "failed",
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
      })
      .catch(() => undefined);

    const failedRun = await store.getRun(runId).catch(() => null);
    if (failedRun) {
      events.emit("run.failed", failedRun, err instanceof Error ? err : new Error(message));
    }

    return null;
  }
}
