/**
 * E2E Test: Full orchestration lifecycle
 *
 * Tests the complete flow using a mock adapter:
 *   1. Create orchestrator with mock adapter
 *   2. Register an agent
 *   3. Invoke agent → run queued → run started → adapter executes → run completed
 *   4. Verify session persisted
 *   5. Invoke again → session resumed
 *   6. Verify session state accumulated
 *   7. Trigger session compaction
 *   8. Cancel a queued run
 *   9. Verify cost tracking and usage accumulation
 *  10. Verify event lifecycle
 *
 * NOTE: This test imports from individual source modules (not index.ts)
 * to avoid loading the 7 bundled adapter files which are heavy.
 */

import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/stores/memory.js";
import { DefaultAuth, NoAuth } from "../src/auth.js";
import { EventEmitter } from "../src/events.js";
import { SimpleWorkspaceResolver } from "../src/workspace.js";
import { NullRunLogger } from "../src/run-log.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { executeRun as execRun } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import type {
  ServerAdapterModule,
  AdapterExecutionContext,
  AdapterExecutionResult,
  Agent,
  Run,
  AdapterModel,
} from "../src/types.js";
import type { Logger } from "../src/interfaces/logger.js";

// ── Lightweight orchestrator (no adapter bundle imports) ──

interface LightOrchestrator {
  invoke(agentId: string, opts?: Record<string, unknown>): Promise<Run | null>;
  registerAgent(agent: Record<string, unknown>): Promise<Agent>;
  cancelRun(runId: string): Promise<boolean>;
  listModels(): Promise<Array<{ adapterType: string; models: AdapterModel[] }>>;
  on: EventEmitter["on"];
  store: MemoryStore;
  events: EventEmitter;
}

function createLightOrchestrator(opts: {
  store: MemoryStore;
  adapters: ServerAdapterModule[];
  workspace: { defaultCwd: string };
  auth?: DefaultAuth;
}): LightOrchestrator {
  const store = opts.store;
  const registry = new AdapterRegistry(opts.adapters);
  const events = new EventEmitter();
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const runLogger = new NullRunLogger();
  const workspace = new SimpleWorkspaceResolver(opts.workspace);
  const auth = opts.auth ?? new NoAuth();

  const executorDeps = {
    store,
    getAdapter: (t: string) => registry.get(t),
    workspace,
    auth,
    runLogger,
    logger,
    events,
  };

  const scheduler = createScheduler({
    store,
    events,
    logger,
    executeRun: (runId) => execRun(runId, executorDeps).then(() => undefined),
  });

  return {
    async invoke(agentId, invokeOpts) {
      return scheduler.invoke(agentId, invokeOpts as any);
    },
    async registerAgent(agent) {
      return store.createAgent({
        id: (agent.id as string) ?? "",
        tenantId: agent.tenantId as string,
        name: agent.name as string,
        adapterType: agent.adapterType as string,
        adapterConfig: (agent.adapterConfig as Record<string, unknown>) ?? {},
        runtimeConfig: agent.runtimeConfig as Record<string, unknown> | undefined,
        metadata: agent.metadata as Record<string, unknown> | undefined,
        status: (agent.status as string) ?? "active",
      });
    },
    async cancelRun(runId) {
      return scheduler.cancelRun(runId);
    },
    async listModels() {
      return registry.listAllModels();
    },
    on: events.on.bind(events) as EventEmitter["on"],
    store,
    events,
  };
}

// ── Mock adapter ──

function createMockAdapter() {
  const invocations: AdapterExecutionContext[] = [];

  const adapter: ServerAdapterModule = {
    type: "e2e_mock",

    async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
      invocations.push(ctx);

      const prevStep = (ctx.runtime.sessionParams?.step as number) ?? 0;
      const newStep = prevStep + 1;

      await ctx.onLog("stdout", `Step ${newStep}: processing\n`);
      await ctx.onLog("stderr", `debug: step=${newStep}\n`);

      await new Promise((r) => setTimeout(r, 10));

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: {
          inputTokens: 500 * newStep,
          outputTokens: 200 * newStep,
          cachedInputTokens: 50 * newStep,
        },
        sessionId: `session-${ctx.agent.id}`,
        sessionParams: {
          sessionId: `session-${ctx.agent.id}`,
          cwd: "/tmp/e2e-test",
          step: newStep,
          history: [
            ...((ctx.runtime.sessionParams?.history as string[]) ?? []),
            `step-${newStep}`,
          ],
        },
        sessionDisplayId: `e2e-session-${newStep}`,
        provider: "mock-provider",
        model: "mock-model-v1",
        billingType: "api",
        costUsd: 0.01 * newStep,
      };
    },

    async testEnvironment() {
      return { status: "pass" as const, checks: [] };
    },

    sessionCodec: {
      deserialize(raw: unknown) {
        if (raw && typeof raw === "object") return raw as Record<string, unknown>;
        return null;
      },
      serialize(params: Record<string, unknown> | null) {
        return params;
      },
      getDisplayId(params: Record<string, unknown> | null) {
        return params?.step ? `e2e-step-${params.step}` : null;
      },
    },

    models: [{ id: "mock-model-v1", name: "Mock Model v1" }],
  };

  return { adapter, invocations };
}

// ── Helper ──

async function invokeAndWait(
  orchestrator: LightOrchestrator,
  agentId: string,
  opts: { taskKey?: string; prompt?: string } = {},
) {
  const run = await orchestrator.invoke(agentId, {
    source: "on_demand",
    contextSnapshot: opts.taskKey ? { taskKey: opts.taskKey } : {},
  });

  if (!run) return null;

  let current = await orchestrator.store.getRun(run.id);
  let attempts = 0;
  while (current && (current.status === "queued" || current.status === "running")) {
    await new Promise((r) => setTimeout(r, 20));
    current = await orchestrator.store.getRun(run.id);
    if (++attempts > 200) throw new Error("Run did not complete in time");
  }
  return current;
}

// ── The Test ──

describe("E2E: Full orchestration lifecycle", () => {
  it("register → invoke → session → resume → compact → cancel → verify", async () => {
    const { adapter, invocations } = createMockAdapter();
    const store = new MemoryStore();

    const eventLog: { event: string; data: unknown[] }[] = [];

    const orchestrator = createLightOrchestrator({
      store,
      adapters: [adapter],
      workspace: { defaultCwd: "/tmp/e2e-test" },
    });

    for (const eventName of [
      "run.queued",
      "run.started",
      "run.completed",
      "run.failed",
      "run.cancelled",
      "session.rotated",
    ] as const) {
      orchestrator.on(eventName, (...args: unknown[]) => {
        eventLog.push({ event: eventName, data: args });
      });
    }

    // ── Step 1: Register agent ──
    const agent = await orchestrator.registerAgent({
      name: "e2e-test-agent",
      tenantId: "e2e-co",
      adapterType: "e2e_mock",
      adapterConfig: { model: "mock-model-v1" },
      runtimeConfig: {
        sessionCompaction: {
          enabled: true,
          maxSessionRuns: 3,
          maxRawInputTokens: 999_999,
          maxSessionAgeHours: 999,
        },
      },
    });

    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("e2e-test-agent");

    // ── Step 2: First invocation (fresh session) ──
    const run1 = await invokeAndWait(orchestrator, agent.id, {
      taskKey: "project-x",
    });

    expect(run1).not.toBeNull();
    expect(run1!.status).toBe("succeeded");
    expect(run1!.exitCode).toBe(0);
    expect(run1!.stdoutExcerpt).toContain("Step 1: processing");

    // Verify session persisted
    let session = await store.getTaskSession("e2e-co", agent.id, "e2e_mock", "project-x");
    expect(session).not.toBeNull();
    expect(session!.runCount).toBe(1);
    expect((session!.sessionParamsJson as any)?.step).toBe(1);

    // Adapter received fresh session
    expect(invocations[0]!.runtime.sessionId).toBeNull();
    expect(invocations[0]!.runtime.sessionParams).toBeNull();

    // ── Step 3: Second invocation (session resume) ──
    const run2 = await invokeAndWait(orchestrator, agent.id, {
      taskKey: "project-x",
    });

    expect(run2!.status).toBe("succeeded");
    expect(invocations[1]!.runtime.sessionId).toBe(`session-${agent.id}`);
    expect((invocations[1]!.runtime.sessionParams as any)?.step).toBe(1);

    session = await store.getTaskSession("e2e-co", agent.id, "e2e_mock", "project-x");
    expect(session!.runCount).toBe(2);

    // ── Step 4: Different taskKey (fresh session) ──
    const run3 = await invokeAndWait(orchestrator, agent.id, {
      taskKey: "project-y",
    });

    expect(run3!.status).toBe("succeeded");
    expect(invocations[2]!.runtime.sessionId).toBeNull();

    // ── Step 5: Back to project-x, third run ──
    const run4 = await invokeAndWait(orchestrator, agent.id, {
      taskKey: "project-x",
    });
    expect(run4!.status).toBe("succeeded");

    session = await store.getTaskSession("e2e-co", agent.id, "e2e_mock", "project-x");
    expect(session!.runCount).toBe(3);

    // ── Step 6: Fourth project-x run — compaction triggers ──
    const run5 = await invokeAndWait(orchestrator, agent.id, {
      taskKey: "project-x",
    });
    expect(run5!.status).toBe("succeeded");

    // Adapter received null session (rotated)
    expect(invocations[4]!.runtime.sessionId).toBeNull();
    expect(invocations[4]!.runtime.sessionParams).toBeNull();

    // session.rotated event emitted
    const rotationEvents = eventLog.filter((e) => e.event === "session.rotated");
    expect(rotationEvents.length).toBeGreaterThanOrEqual(1);

    // ── Step 7: Cancel a queued run ──
    const queuedRun = await store.createRun({
      tenantId: "e2e-co",
      agentId: agent.id,
      invocationSource: "on_demand",
    });

    const cancelled = await orchestrator.cancelRun(queuedRun.id);
    expect(cancelled).toBe(true);

    const cancelledRun = await store.getRun(queuedRun.id);
    expect(cancelledRun!.status).toBe("cancelled");

    // ── Step 8: Verify cost tracking ──
    const costs = store.getCostEvents();
    expect(costs.length).toBeGreaterThanOrEqual(5);
    const totalCostCents = costs.reduce((sum, c) => sum + (c.costCents ?? 0), 0);
    expect(totalCostCents).toBeGreaterThan(0);

    // ── Step 9: Verify usage accumulation ──
    const runtimeState = await store.ensureRuntimeState(agent.id, "e2e-co", "e2e_mock");
    expect(runtimeState.totalInputTokens).toBeGreaterThan(0);
    expect(runtimeState.totalOutputTokens).toBeGreaterThan(0);
    expect(runtimeState.totalCachedInputTokens).toBeGreaterThan(0);

    // ── Step 10: Verify events ──
    const queuedEvents = eventLog.filter((e) => e.event === "run.queued");
    const completedEvents = eventLog.filter((e) => e.event === "run.completed");
    expect(queuedEvents.length).toBeGreaterThanOrEqual(5);
    expect(completedEvents.length).toBeGreaterThanOrEqual(5);

    // ── Step 11: Verify models listing ──
    const models = await orchestrator.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.adapterType).toBe("e2e_mock");
  });
});
