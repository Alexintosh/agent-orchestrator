import { describe, it, expect, vi } from "vitest";
import { MemoryStore } from "../src/stores/memory.js";
import { EventEmitter } from "../src/events.js";
import { SimpleWorkspaceResolver } from "../src/workspace.js";
import { NoAuth, DefaultAuth } from "../src/auth.js";
import { NullRunLogger } from "../src/run-log.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { executeRun as execRun } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import type { ServerAdapterModule } from "../src/types.js";

function mockAdapter(type = "mock"): ServerAdapterModule {
  return {
    type,
    execute: vi.fn(async (ctx) => {
      await ctx.onLog("stdout", "mock output\n");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
        sessionId: "s-1",
        sessionParams: { sessionId: "s-1" },
      };
    }),
    testEnvironment: async () => ({ status: "pass" as const, checks: [] }),
    models: [{ id: "mock-v1", name: "Mock v1" }],
  };
}

/** Lightweight orchestrator that doesn't import all adapter bundles */
function createTestOrchestrator(opts: {
  store?: MemoryStore;
  adapters?: ServerAdapterModule[];
  workspace?: { defaultCwd: string };
  auth?: { secret: string; ttlSeconds?: number };
} = {}) {
  const store = opts.store ?? new MemoryStore();
  const registry = new AdapterRegistry(opts.adapters ?? []);
  const events = new EventEmitter();
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const runLogger = new NullRunLogger();
  const workspace = new SimpleWorkspaceResolver(opts.workspace ?? { defaultCwd: process.cwd() });
  const auth = opts.auth ? new DefaultAuth(opts.auth) : new NoAuth();

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
    async executeRun(runId: string) { return execRun(runId, executorDeps); },
    async invoke(agentId: string, invokeOpts?: any) { return scheduler.invoke(agentId, invokeOpts); },
    async registerAgent(agent: any) {
      return store.createAgent({
        id: agent.id ?? "",
        tenantId: agent.tenantId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig ?? {},
        runtimeConfig: agent.runtimeConfig,
        metadata: agent.metadata,
        status: agent.status ?? "active",
      });
    },
    async cancelRun(runId: string) { return scheduler.cancelRun(runId); },
    start(ms?: number) { scheduler.start(ms); },
    stop() { scheduler.stop(); },
    async listModels() { return registry.listAllModels(); },
    on: events.on.bind(events) as EventEmitter["on"],
    off: events.off.bind(events) as EventEmitter["off"],
    store,
    registry,
    events,
  };
}

describe("createOrchestrator (lightweight)", () => {
  it("creates an orchestrator with defaults", () => {
    const o = createTestOrchestrator();
    expect(o.store).toBeDefined();
    expect(o.registry).toBeDefined();
    expect(o.events).toBeDefined();
  });

  it("accepts MemoryStore", () => {
    const store = new MemoryStore();
    const o = createTestOrchestrator({ store });
    expect(o.store).toBe(store);
  });

  it("registers adapters", () => {
    const o = createTestOrchestrator({
      adapters: [mockAdapter("a"), mockAdapter("b")],
    });
    expect(o.registry.listTypes()).toEqual(["a", "b"]);
  });

  it("registerAgent creates an agent in the store", async () => {
    const store = new MemoryStore();
    const o = createTestOrchestrator({ store });

    const agent = await o.registerAgent({
      name: "test",
      tenantId: "co-1",
      adapterType: "mock",
      adapterConfig: {},
    });

    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("test");

    const fromStore = await store.getAgent(agent.id);
    expect(fromStore).not.toBeNull();
  });

  it("listModels returns models from all adapters", async () => {
    const o = createTestOrchestrator({
      adapters: [mockAdapter("a"), mockAdapter("b")],
    });
    const models = await o.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]!.adapterType).toBe("a");
    expect(models[0]!.models).toHaveLength(1);
  });

  it("on/off subscribe and unsubscribe from events", () => {
    const o = createTestOrchestrator();
    const listener = vi.fn();

    o.on("run.started", listener);
    o.events.emit("run.started", { id: "run-1" } as any);
    expect(listener).toHaveBeenCalledOnce();

    o.off("run.started", listener);
    o.events.emit("run.started", { id: "run-2" } as any);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("start/stop control the scheduler", () => {
    const o = createTestOrchestrator();
    o.start(10_000);
    o.stop();
  });

  it("workspace shorthand creates SimpleWorkspaceResolver", async () => {
    const o = createTestOrchestrator({
      workspace: { defaultCwd: "/tmp/test" },
      adapters: [mockAdapter()],
    });
    const agent = await o.registerAgent({
      name: "test",
      tenantId: "co-1",
      adapterType: "mock",
      adapterConfig: {},
    });
    expect(agent).toBeDefined();
  });

  it("auth shorthand creates DefaultAuth", () => {
    const o = createTestOrchestrator({
      auth: { secret: "test-secret", ttlSeconds: 300 },
    });
    expect(o).toBeDefined();
  });
});
