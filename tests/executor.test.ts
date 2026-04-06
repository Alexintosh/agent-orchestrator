import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeRun, type ExecutorDeps } from "../src/executor.js";
import { MemoryStore } from "../src/stores/memory.js";
import { EventEmitter } from "../src/events.js";
import { SimpleWorkspaceResolver } from "../src/workspace.js";
import { NoAuth } from "../src/auth.js";
import { NullRunLogger } from "../src/run-log.js";
import type { ServerAdapterModule, AdapterExecutionResult } from "../src/types.js";
import type { Logger } from "../src/interfaces/logger.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function mockAdapter(overrides?: Partial<AdapterExecutionResult>): ServerAdapterModule {
  return {
    type: "mock",
    execute: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
      sessionId: "session-abc",
      sessionParams: { sessionId: "session-abc", cwd: "/tmp" },
      sessionDisplayId: "mock-abc",
      ...overrides,
    })),
    testEnvironment: async () => ({ status: "pass" as const, checks: [] }),
  };
}

describe("executeRun", () => {
  let store: MemoryStore;
  let events: EventEmitter;
  let logger: Logger;
  let adapter: ServerAdapterModule;

  function makeDeps(adapterOverride?: ServerAdapterModule): ExecutorDeps {
    const a = adapterOverride ?? adapter;
    return {
      store,
      getAdapter: () => a,
      workspace: new SimpleWorkspaceResolver({ defaultCwd: "/tmp/test-workspace" }),
      auth: new NoAuth(),
      runLogger: new NullRunLogger(),
      logger,
      events,
    };
  }

  beforeEach(() => {
    store = new MemoryStore();
    events = new EventEmitter();
    logger = makeLogger();
    adapter = mockAdapter();
  });

  async function setupAgentAndRun(taskKey?: string) {
    const agent = await store.createAgent({
      id: "agent-1",
      tenantId: "co-1",
      name: "Test Agent",
      adapterType: "mock",
      adapterConfig: { model: "test" },
    });
    await store.ensureRuntimeState("agent-1", "co-1", "mock");

    const contextSnapshot = taskKey ? { taskKey } : {};
    const run = await store.createRun({
      tenantId: "co-1",
      agentId: "agent-1",
      invocationSource: "on_demand",
      contextSnapshot,
    });
    return { agent, run };
  }

  it("executes a queued run end-to-end", async () => {
    const { run } = await setupAgentAndRun("task-1");
    const result = await executeRun(run.id, makeDeps());

    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(0);

    const updatedRun = await store.getRun(run.id);
    expect(updatedRun!.status).toBe("succeeded");
    expect(updatedRun!.exitCode).toBe(0);
    expect(updatedRun!.finishedAt).toBeInstanceOf(Date);
  });

  it("emits run.started and run.completed events", async () => {
    const { run } = await setupAgentAndRun("task-1");
    const started = vi.fn();
    const completed = vi.fn();
    events.on("run.started", started);
    events.on("run.completed", completed);

    await executeRun(run.id, makeDeps());

    expect(started).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  });

  it("records usage in runtime state", async () => {
    const { run } = await setupAgentAndRun("task-1");
    await executeRun(run.id, makeDeps());

    const state = await store.ensureRuntimeState("agent-1", "co-1", "mock");
    expect(state.totalInputTokens).toBe(100);
    expect(state.totalOutputTokens).toBe(50);
    expect(state.totalCachedInputTokens).toBe(10);
  });

  it("records cost event", async () => {
    const costAdapter = mockAdapter({ costUsd: 0.05 });
    const { run } = await setupAgentAndRun("task-1");
    await executeRun(run.id, makeDeps(costAdapter));

    const costs = store.getCostEvents();
    expect(costs).toHaveLength(1);
    expect(costs[0]!.costCents).toBe(5);
  });

  it("persists session for taskKey", async () => {
    const { run } = await setupAgentAndRun("task-1");
    await executeRun(run.id, makeDeps());

    const session = await store.getTaskSession("co-1", "agent-1", "mock", "task-1");
    expect(session).not.toBeNull();
    expect(session!.sessionParamsJson).toEqual({ sessionId: "session-abc", cwd: "/tmp" });
    expect(session!.sessionDisplayId).toBe("mock-abc");
  });

  it("clears session when adapter returns clearSession", async () => {
    // First: create a session
    const { run: run1 } = await setupAgentAndRun("task-1");
    await executeRun(run1.id, makeDeps());

    // Verify session exists
    let session = await store.getTaskSession("co-1", "agent-1", "mock", "task-1");
    expect(session).not.toBeNull();

    // Second: run with clearSession
    const clearAdapter = mockAdapter({ clearSession: true });
    const run2 = await store.createRun({
      tenantId: "co-1",
      agentId: "agent-1",
      invocationSource: "on_demand",
      contextSnapshot: { taskKey: "task-1" },
    });
    await executeRun(run2.id, makeDeps(clearAdapter));

    session = await store.getTaskSession("co-1", "agent-1", "mock", "task-1");
    expect(session).toBeNull();
  });

  it("marks run as failed on adapter error", async () => {
    const failAdapter = mockAdapter({
      exitCode: 1,
      errorMessage: "Something broke",
      errorCode: "tool_error",
    });
    const { run } = await setupAgentAndRun("task-1");

    const failed = vi.fn();
    events.on("run.failed", failed);

    await executeRun(run.id, makeDeps(failAdapter));

    const updatedRun = await store.getRun(run.id);
    expect(updatedRun!.status).toBe("failed");
    expect(updatedRun!.error).toBe("Something broke");
    expect(updatedRun!.errorCode).toBe("tool_error");
    expect(failed).toHaveBeenCalledOnce();
  });

  it("marks run as timed_out when adapter times out", async () => {
    const timedOutAdapter = mockAdapter({ timedOut: true, exitCode: null });
    const { run } = await setupAgentAndRun("task-1");

    await executeRun(run.id, makeDeps(timedOutAdapter));

    const updatedRun = await store.getRun(run.id);
    expect(updatedRun!.status).toBe("timed_out");
    expect(updatedRun!.errorCode).toBe("timeout");
  });

  it("returns null for non-existent run", async () => {
    const result = await executeRun("nonexistent", makeDeps());
    expect(result).toBeNull();
  });

  it("returns null for already-completed run", async () => {
    const { run } = await setupAgentAndRun();
    await store.updateRun(run.id, { status: "succeeded" });
    const result = await executeRun(run.id, makeDeps());
    expect(result).toBeNull();
  });

  it("handles missing agent gracefully", async () => {
    const run = await store.createRun({
      tenantId: "co-1",
      agentId: "nonexistent-agent",
      invocationSource: "on_demand",
    });
    const result = await executeRun(run.id, makeDeps());
    expect(result).toBeNull();

    const updatedRun = await store.getRun(run.id);
    expect(updatedRun!.status).toBe("failed");
    expect(updatedRun!.errorCode).toBe("agent_not_found");
  });

  it("handles adapter throwing an exception", async () => {
    const throwingAdapter: ServerAdapterModule = {
      type: "mock",
      execute: async () => { throw new Error("Adapter crashed"); },
      testEnvironment: async () => ({ status: "pass" as const, checks: [] }),
    };
    const { run } = await setupAgentAndRun("task-1");

    const failed = vi.fn();
    events.on("run.failed", failed);

    const result = await executeRun(run.id, makeDeps(throwingAdapter));
    expect(result).toBeNull();

    const updatedRun = await store.getRun(run.id);
    expect(updatedRun!.status).toBe("failed");
    expect(updatedRun!.error).toBe("Adapter crashed");
    expect(failed).toHaveBeenCalledOnce();
  });

  it("captures stdout/stderr excerpts", async () => {
    const loggingAdapter: ServerAdapterModule = {
      type: "mock",
      execute: async (ctx) => {
        await ctx.onLog("stdout", "Hello from agent\n");
        await ctx.onLog("stderr", "Warning: something\n");
        return { exitCode: 0, signal: null, timedOut: false };
      },
      testEnvironment: async () => ({ status: "pass" as const, checks: [] }),
    };
    const { run } = await setupAgentAndRun("task-1");
    await executeRun(run.id, makeDeps(loggingAdapter));

    const updatedRun = await store.getRun(run.id);
    expect(updatedRun!.stdoutExcerpt).toContain("Hello from agent");
    expect(updatedRun!.stderrExcerpt).toContain("Warning: something");
  });

  it("session compaction triggers rotation when run count exceeds limit", async () => {
    const agent = await store.createAgent({
      id: "agent-1",
      tenantId: "co-1",
      name: "Test Agent",
      adapterType: "mock",
      adapterConfig: {},
      runtimeConfig: {
        sessionCompaction: {
          enabled: true,
          maxSessionRuns: 2,
          maxRawInputTokens: 999_999_999,
          maxSessionAgeHours: 999,
        },
      },
    });
    await store.ensureRuntimeState("agent-1", "co-1", "mock");

    // Create session with runCount=1
    await store.upsertTaskSession({
      tenantId: "co-1",
      agentId: "agent-1",
      adapterType: "mock",
      taskKey: "task-1",
      sessionParamsJson: { sessionId: "old-session" },
      sessionDisplayId: "old-session",
    });
    // Bump runCount to 2 (meets maxSessionRuns threshold)
    await store.upsertTaskSession({
      tenantId: "co-1",
      agentId: "agent-1",
      adapterType: "mock",
      taskKey: "task-1",
      sessionParamsJson: { sessionId: "old-session" },
      sessionDisplayId: "old-session",
    });

    const rotated = vi.fn();
    events.on("session.rotated", rotated);

    const run = await store.createRun({
      tenantId: "co-1",
      agentId: "agent-1",
      invocationSource: "on_demand",
      contextSnapshot: { taskKey: "task-1" },
    });

    await executeRun(run.id, makeDeps());

    // Session should have been rotated
    expect(rotated).toHaveBeenCalledOnce();

    // Adapter should have received null session (fresh start)
    const executeFn = adapter.execute as ReturnType<typeof vi.fn>;
    const ctx = executeFn.mock.calls[0]![0];
    expect(ctx.runtime.sessionId).toBeNull();
    expect(ctx.runtime.sessionParams).toBeNull();
  });
});
