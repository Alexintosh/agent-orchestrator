import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../src/stores/memory.js";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // ── Agent operations ──

  describe("agent operations", () => {
    it("creates an agent with auto-generated id", async () => {
      const agent = await store.createAgent({
        id: "",
        tenantId: "co-1",
        name: "test-agent",
        adapterType: "claude_local",
        adapterConfig: { model: "sonnet" },
      });

      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe("test-agent");
      expect(agent.tenantId).toBe("co-1");
      expect(agent.createdAt).toBeInstanceOf(Date);
      expect(agent.updatedAt).toBeInstanceOf(Date);
    });

    it("creates an agent with explicit id", async () => {
      const agent = await store.createAgent({
        id: "my-agent-id",
        tenantId: "co-1",
        name: "test-agent",
        adapterType: "claude_local",
        adapterConfig: {},
      });
      expect(agent.id).toBe("my-agent-id");
    });

    it("gets an agent by id", async () => {
      const created = await store.createAgent({
        id: "a1",
        tenantId: "co-1",
        name: "test",
        adapterType: "mock",
        adapterConfig: {},
      });
      const found = await store.getAgent("a1");
      expect(found).toEqual(created);
    });

    it("returns null for non-existent agent", async () => {
      expect(await store.getAgent("nonexistent")).toBeNull();
    });

    it("updates an agent", async () => {
      await store.createAgent({
        id: "a1",
        tenantId: "co-1",
        name: "old-name",
        adapterType: "mock",
        adapterConfig: {},
      });
      await store.updateAgent("a1", { name: "new-name" });
      const agent = await store.getAgent("a1");
      expect(agent!.name).toBe("new-name");
    });
  });

  // ── Run operations ──

  describe("run operations", () => {
    it("creates a run in queued status", async () => {
      const run = await store.createRun({
        tenantId: "co-1",
        agentId: "a1",
        invocationSource: "on_demand",
      });
      expect(run.id).toBeTruthy();
      expect(run.status).toBe("queued");
      expect(run.startedAt).toBeNull();
    });

    it("claims a queued run (queued → running)", async () => {
      const run = await store.createRun({
        tenantId: "co-1",
        agentId: "a1",
        invocationSource: "on_demand",
      });
      const claimed = await store.claimRun(run.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe("running");
      expect(claimed!.startedAt).toBeInstanceOf(Date);
    });

    it("cannot claim an already-claimed run", async () => {
      const run = await store.createRun({
        tenantId: "co-1",
        agentId: "a1",
        invocationSource: "on_demand",
      });
      await store.claimRun(run.id);
      const secondClaim = await store.claimRun(run.id);
      expect(secondClaim).toBeNull();
    });

    it("gets queued runs ordered by creation time", async () => {
      await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      await store.createRun({ tenantId: "co-1", agentId: "a2", invocationSource: "on_demand" });

      const queued = await store.getQueuedRuns("a1", 10);
      expect(queued).toHaveLength(2);
      expect(queued[0]!.createdAt.getTime()).toBeLessThanOrEqual(queued[1]!.createdAt.getTime());
    });

    it("respects limit on getQueuedRuns", async () => {
      await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });

      const queued = await store.getQueuedRuns("a1", 2);
      expect(queued).toHaveLength(2);
    });

    it("counts running runs", async () => {
      const run1 = await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      const run2 = await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      await store.claimRun(run1.id);

      expect(await store.getRunningCount("a1")).toBe(1);

      await store.claimRun(run2.id);
      expect(await store.getRunningCount("a1")).toBe(2);
    });

    it("updates a run", async () => {
      const run = await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      await store.updateRun(run.id, { status: "failed", error: "oops" });
      const updated = await store.getRun(run.id);
      expect(updated!.status).toBe("failed");
      expect(updated!.error).toBe("oops");
    });

    it("returns null for non-existent run", async () => {
      expect(await store.getRun("nonexistent")).toBeNull();
    });
  });

  // ── Session operations ──

  describe("session operations", () => {
    it("creates and retrieves a task session", async () => {
      await store.upsertTaskSession({
        tenantId: "co-1",
        agentId: "a1",
        adapterType: "mock",
        taskKey: "task-1",
        sessionParamsJson: { sessionId: "s1" },
        sessionDisplayId: "s1-display",
      });

      const session = await store.getTaskSession("co-1", "a1", "mock", "task-1");
      expect(session).not.toBeNull();
      expect(session!.taskKey).toBe("task-1");
      expect(session!.sessionParamsJson).toEqual({ sessionId: "s1" });
      expect(session!.runCount).toBe(1);
    });

    it("increments runCount on upsert", async () => {
      await store.upsertTaskSession({
        tenantId: "co-1", agentId: "a1", adapterType: "mock", taskKey: "task-1",
      });
      await store.upsertTaskSession({
        tenantId: "co-1", agentId: "a1", adapterType: "mock", taskKey: "task-1",
      });

      const session = await store.getTaskSession("co-1", "a1", "mock", "task-1");
      expect(session!.runCount).toBe(2);
    });

    it("clears a task session", async () => {
      await store.upsertTaskSession({
        tenantId: "co-1", agentId: "a1", adapterType: "mock", taskKey: "task-1",
      });
      await store.clearTaskSession("a1", "task-1");
      const session = await store.getTaskSession("co-1", "a1", "mock", "task-1");
      expect(session).toBeNull();
    });

    it("returns null for non-existent session", async () => {
      expect(await store.getTaskSession("co-1", "a1", "mock", "nope")).toBeNull();
    });
  });

  // ── Runtime state ──

  describe("runtime state", () => {
    it("creates runtime state on first access", async () => {
      const state = await store.ensureRuntimeState("a1", "co-1", "mock");
      expect(state.agentId).toBe("a1");
      expect(state.totalInputTokens).toBe(0);
      expect(state.totalOutputTokens).toBe(0);
    });

    it("returns existing state on subsequent access", async () => {
      await store.ensureRuntimeState("a1", "co-1", "mock");
      await store.updateRuntimeState("a1", { lastRunId: "run-1" });
      const state = await store.ensureRuntimeState("a1", "co-1", "mock");
      expect(state.lastRunId).toBe("run-1");
    });

    it("accumulates usage correctly", async () => {
      await store.ensureRuntimeState("a1", "co-1", "mock");
      await store.accumulateUsage("a1", { inputTokens: 100, outputTokens: 50, cachedInputTokens: 25 });
      await store.accumulateUsage("a1", { inputTokens: 200, outputTokens: 100, cachedInputTokens: 50 });

      const state = await store.ensureRuntimeState("a1", "co-1", "mock");
      expect(state.totalInputTokens).toBe(300);
      expect(state.totalOutputTokens).toBe(150);
      expect(state.totalCachedInputTokens).toBe(75);
    });
  });

  // ── Cost tracking ──

  describe("cost tracking", () => {
    it("records cost events", async () => {
      await store.recordCost({
        tenantId: "co-1",
        agentId: "a1",
        runId: "run-1",
        costCents: 150,
        currency: "USD",
      });

      const events = store.getCostEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.costCents).toBe(150);
      expect(events[0]!.id).toBeTruthy();
    });
  });

  // ── Wakeup requests ──

  describe("wakeup requests", () => {
    it("creates and retrieves wakeup requests", async () => {
      const wr = await store.createWakeupRequest({
        agentId: "a1",
        tenantId: "co-1",
        status: "queued",
        source: "on_demand",
      });
      expect(wr.id).toBeTruthy();
      expect(wr.status).toBe("queued");

      const found = await store.getWakeupRequest(wr.id);
      expect(found).toEqual(wr);
    });

    it("updates wakeup requests", async () => {
      const wr = await store.createWakeupRequest({
        agentId: "a1",
        tenantId: "co-1",
        status: "queued",
        source: "on_demand",
      });
      await store.updateWakeupRequest(wr.id, { status: "completed" });
      const updated = await store.getWakeupRequest(wr.id);
      expect(updated!.status).toBe("completed");
    });

    it("gets pending wakeup requests for an agent", async () => {
      await store.createWakeupRequest({ agentId: "a1", tenantId: "co-1", status: "queued", source: "on_demand" });
      await store.createWakeupRequest({ agentId: "a1", tenantId: "co-1", status: "completed", source: "on_demand" });
      await store.createWakeupRequest({ agentId: "a2", tenantId: "co-1", status: "queued", source: "on_demand" });

      const pending = await store.getPendingWakeupRequests("a1");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.status).toBe("queued");
    });
  });

  // ── Clear ──

  describe("clear", () => {
    it("clears all data", async () => {
      await store.createAgent({ id: "a1", tenantId: "co-1", name: "t", adapterType: "m", adapterConfig: {} });
      await store.createRun({ tenantId: "co-1", agentId: "a1", invocationSource: "on_demand" });
      store.clear();

      expect(await store.getAgent("a1")).toBeNull();
      expect(store.getCostEvents()).toHaveLength(0);
    });
  });
});
