import { randomUUID } from "node:crypto";
import type { OrchestratorStore } from "./interfaces/store.js";
import type { OrchestratorEventEmitter } from "./interfaces/events.js";
import type { Logger } from "./interfaces/logger.js";
import type { Run, InvocationSource, TriggerDetail } from "./types.js";
import { parseObject, asNumber } from "./adapters/_shared/utils.js";
import { enrichWakeContextSnapshot } from "./session.js";

const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const MAX_CONCURRENT_RUNS_LIMIT = 10;
const startLocksByAgent = new Map<string, Promise<void>>();

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, DEFAULT_MAX_CONCURRENT_RUNS));
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT_RUNS;
  return Math.max(
    DEFAULT_MAX_CONCURRENT_RUNS,
    Math.min(MAX_CONCURRENT_RUNS_LIMIT, parsed),
  );
}

async function withAgentStartLock<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

export interface WakeupOptions {
  source?: InvocationSource;
  triggerDetail?: TriggerDetail;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

export interface SchedulerDeps {
  store: OrchestratorStore;
  events: OrchestratorEventEmitter;
  logger: Logger;
  executeRun: (runId: string) => Promise<void>;
}

/**
 * Create the scheduler — handles wakeup queuing, timer ticks, and concurrency control.
 * Adapted from Paperclip's heartbeat.ts enqueueWakeup/tickTimers/startNextQueuedRunForAgent.
 */
export function createScheduler(deps: SchedulerDeps) {
  const { store, events, logger, executeRun } = deps;
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  const activeExecutions = new Set<string>();

  /**
   * Enqueue a wakeup for an agent — queue a run and optionally start it immediately.
   */
  async function invoke(
    agentId: string,
    opts: WakeupOptions = {},
  ): Promise<Run | null> {
    const agent = await store.getAgent(agentId);
    if (!agent) {
      logger.warn({ agentId }, "cannot invoke: agent not found");
      return null;
    }

    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? "manual";
    const contextSnapshot = opts.contextSnapshot ?? {};

    // Enrich context
    enrichWakeContextSnapshot({
      contextSnapshot,
      reason: opts.reason ?? null,
      source,
      triggerDetail,
      payload: opts.payload ?? null,
    });

    // Create the run
    const run = await store.createRun({
      tenantId: agent.tenantId,
      agentId: agent.id,
      invocationSource: source,
      triggerDetail,
      contextSnapshot,
    });

    events.emit("run.queued", run);

    // Try to start immediately
    void startNextQueuedRunForAgent(agentId);

    return run;
  }

  /**
   * Start the next queued run for an agent, respecting concurrency limits.
   */
  async function startNextQueuedRunForAgent(agentId: string): Promise<void> {
    await withAgentStartLock(agentId, async () => {
      const agent = await store.getAgent(agentId);
      if (!agent) return;

      const maxConcurrent = normalizeMaxConcurrentRuns(
        parseObject(agent.runtimeConfig).maxConcurrentRuns ??
          parseObject(agent.metadata).maxConcurrentRuns,
      );

      const runningCount = await store.getRunningCount(agentId);
      if (runningCount >= maxConcurrent) return;

      const queuedRuns = await store.getQueuedRuns(agentId, 1);
      if (queuedRuns.length === 0) return;

      const nextRun = queuedRuns[0]!;

      if (activeExecutions.has(nextRun.id)) return;
      activeExecutions.add(nextRun.id);

      // Execute in background — don't await
      void executeRun(nextRun.id)
        .catch((err) => {
          logger.error(
            { err, runId: nextRun.id, agentId },
            "failed to execute queued run",
          );
        })
        .finally(() => {
          activeExecutions.delete(nextRun.id);
          // Try to start more runs after this one completes
          void startNextQueuedRunForAgent(agentId);
        });
    });
  }

  /**
   * Cancel a queued or running run.
   */
  async function cancelRun(runId: string): Promise<boolean> {
    const run = await store.getRun(runId);
    if (!run) return false;
    if (run.status !== "queued" && run.status !== "running") return false;

    await store.updateRun(runId, {
      status: "cancelled",
      finishedAt: new Date(),
      errorCode: "cancelled",
    });

    const cancelledRun = await store.getRun(runId);
    if (cancelledRun) {
      events.emit("run.cancelled", cancelledRun);
    }

    return true;
  }

  /**
   * Start periodic timer that checks for agents needing heartbeat runs.
   */
  function start(intervalMs = 60_000): void {
    if (timerInterval) return;
    timerInterval = setInterval(() => {
      void tickTimers().catch((err) => {
        logger.error({ err }, "timer tick failed");
      });
    }, intervalMs);
    logger.info("scheduler started");
  }

  /**
   * Stop the scheduler timer.
   */
  function stop(): void {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
      logger.info("scheduler stopped");
    }
  }

  /**
   * Timer tick — placeholder for heartbeat scheduling.
   * In a full implementation, this would query agents with heartbeat enabled
   * and enqueue wakeups for those whose interval has elapsed.
   */
  async function tickTimers(): Promise<void> {
    // This is a hook point for heartbeat scheduling.
    // The consumer should implement their own timer logic that calls invoke()
    // for agents that need periodic wakeups.
    //
    // Example:
    //   const agents = await store.getHeartbeatAgents();
    //   for (const agent of agents) {
    //     if (agent.lastHeartbeatAt + agent.intervalSec * 1000 < Date.now()) {
    //       await invoke(agent.id, { source: 'timer', triggerDetail: 'system' });
    //     }
    //   }
  }

  return {
    invoke,
    cancelRun,
    startNextQueuedRunForAgent,
    start,
    stop,
    tickTimers,
  };
}
