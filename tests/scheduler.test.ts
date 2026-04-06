import { describe, it, expect, vi, beforeEach } from "vitest";
import { createScheduler } from "../src/scheduler.js";
import { MemoryStore } from "../src/stores/memory.js";
import { EventEmitter } from "../src/events.js";
import type { Logger } from "../src/interfaces/logger.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("createScheduler", () => {
  let store: MemoryStore;
  let events: EventEmitter;
  let logger: Logger;

  beforeEach(() => {
    store = new MemoryStore();
    events = new EventEmitter();
    logger = makeLogger();
  });

  async function setupAgent(id = "agent-1") {
    return store.createAgent({
      id,
      tenantId: "co-1",
      name: "Test Agent",
      adapterType: "mock",
      adapterConfig: {},
    });
  }

  /**
   * Creates a mock executeRun that transitions the run to "succeeded"
   * to prevent the scheduler's infinite retry loop.
   */
  function makeMockExecuteRun() {
    return vi.fn(async (runId: string) => {
      await store.claimRun(runId);
      await store.updateRun(runId, {
        status: "succeeded",
        finishedAt: new Date(),
      });
    });
  }

  describe("invoke", () => {
    it("creates a queued run and emits run.queued", async () => {
      await setupAgent();
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      const queued = vi.fn();
      events.on("run.queued", queued);

      const run = await scheduler.invoke("agent-1", { source: "on_demand" });

      expect(run).not.toBeNull();
      expect(run!.status).toBe("queued");
      expect(run!.agentId).toBe("agent-1");
      expect(queued).toHaveBeenCalledOnce();
      // Wait for background execution to drain
      await new Promise((r) => setTimeout(r, 100));
    });

    it("returns null for non-existent agent", async () => {
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      const run = await scheduler.invoke("nonexistent");
      expect(run).toBeNull();
    });

    it("triggers executeRun for the queued run", async () => {
      await setupAgent();
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });

      await scheduler.invoke("agent-1");
      await new Promise((r) => setTimeout(r, 100));

      expect(executeRun).toHaveBeenCalled();
    });

    it("enriches context snapshot with wake fields", async () => {
      await setupAgent();
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });

      const run = await scheduler.invoke("agent-1", {
        source: "on_demand",
        reason: "issue_assigned",
        payload: { issueId: "issue-42" },
      });

      expect(run!.contextSnapshot).toMatchObject({
        wakeReason: "issue_assigned",
        issueId: "issue-42",
      });
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe("cancelRun", () => {
    it("cancels a queued run", async () => {
      await setupAgent();
      // Create run directly to avoid background execution
      const run = await store.createRun({
        tenantId: "co-1",
        agentId: "agent-1",
        invocationSource: "on_demand",
      });

      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      const cancelled = await scheduler.cancelRun(run.id);
      expect(cancelled).toBe(true);

      const updated = await store.getRun(run.id);
      expect(updated!.status).toBe("cancelled");
    });

    it("emits run.cancelled event", async () => {
      await setupAgent();
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      const cancelledHandler = vi.fn();
      events.on("run.cancelled", cancelledHandler);

      const run = await store.createRun({
        tenantId: "co-1",
        agentId: "agent-1",
        invocationSource: "on_demand",
      });
      await scheduler.cancelRun(run.id);

      expect(cancelledHandler).toHaveBeenCalledOnce();
    });

    it("returns false for non-existent run", async () => {
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      expect(await scheduler.cancelRun("nonexistent")).toBe(false);
    });

    it("returns false for already-completed run", async () => {
      await setupAgent();
      const run = await store.createRun({
        tenantId: "co-1",
        agentId: "agent-1",
        invocationSource: "on_demand",
      });
      await store.updateRun(run.id, { status: "succeeded" });

      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      expect(await scheduler.cancelRun(run.id)).toBe(false);
    });
  });

  describe("start/stop", () => {
    it("starts and stops timer without error", () => {
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      scheduler.start(60_000);
      expect(logger.info).toHaveBeenCalledWith("scheduler started");
      scheduler.stop();
      expect(logger.info).toHaveBeenCalledWith("scheduler stopped");
    });

    it("start is idempotent", () => {
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      scheduler.start(60_000);
      scheduler.start(60_000);
      scheduler.stop();
    });

    it("stop is idempotent", () => {
      const executeRun = makeMockExecuteRun();
      const scheduler = createScheduler({ store, events, logger, executeRun });
      scheduler.stop();
      scheduler.stop();
    });
  });
});
