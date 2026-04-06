import { randomUUID } from "node:crypto";
import type { OrchestratorStore } from "../interfaces/store.js";
import type {
  Agent,
  Run,
  NewRun,
  TaskSession,
  RuntimeState,
  UsageDelta,
  CostEvent,
  WakeupRequest,
} from "../types.js";
import { DEFAULT_TENANT_ID } from "../types.js";

/**
 * In-memory store for testing and simple use cases.
 * Not suitable for production — all data is lost on process exit.
 */
export class MemoryStore implements OrchestratorStore {
  private agents = new Map<string, Agent>();
  private runs = new Map<string, Run>();
  private taskSessions = new Map<string, TaskSession>();
  private runtimeStates = new Map<string, RuntimeState>();
  private costEvents: CostEvent[] = [];
  private wakeupRequests = new Map<string, WakeupRequest>();

  // --- Agent operations ---

  async getAgent(id: string): Promise<Agent | null> {
    return this.agents.get(id) ?? null;
  }

  async updateAgent(id: string, patch: Partial<Agent>): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) return;
    Object.assign(agent, patch, { updatedAt: new Date() });
  }

  async createAgent(
    agent: Omit<Agent, "createdAt" | "updatedAt">,
  ): Promise<Agent> {
    const now = new Date();
    const full: Agent = {
      ...agent,
      id: agent.id || randomUUID(),
      tenantId: agent.tenantId || DEFAULT_TENANT_ID,
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(full.id, full);
    return full;
  }

  // --- Run operations ---

  async createRun(input: NewRun): Promise<Run> {
    const now = new Date();
    const run: Run = {
      id: randomUUID(),
      tenantId: input.tenantId,
      agentId: input.agentId,
      invocationSource: input.invocationSource,
      triggerDetail: input.triggerDetail ?? null,
      status: "queued",
      startedAt: null,
      finishedAt: null,
      error: null,
      wakeupRequestId: input.wakeupRequestId ?? null,
      exitCode: null,
      signal: null,
      usageJson: null,
      resultJson: null,
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logBytes: null,
      logSha256: null,
      logCompressed: false,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      errorCode: null,
      externalRunId: null,
      contextSnapshot: input.contextSnapshot ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async claimRun(runId: string): Promise<Run | null> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "queued") return null;
    run.status = "running";
    run.startedAt = new Date();
    run.updatedAt = new Date();
    return { ...run };
  }

  async updateRun(runId: string, patch: Partial<Run>): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    Object.assign(run, patch, { updatedAt: new Date() });
  }

  async getRun(runId: string): Promise<Run | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async getQueuedRuns(agentId: string, limit: number): Promise<Run[]> {
    return Array.from(this.runs.values())
      .filter((r) => r.agentId === agentId && r.status === "queued")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async getRunningCount(agentId: string): Promise<number> {
    return Array.from(this.runs.values()).filter(
      (r) => r.agentId === agentId && r.status === "running",
    ).length;
  }

  async getLatestRunForSession(
    agentId: string,
    sessionId: string,
    excludeRunId?: string,
  ): Promise<Run | null> {
    const runs = Array.from(this.runs.values())
      .filter(
        (r) =>
          r.agentId === agentId &&
          r.sessionIdAfter === sessionId &&
          r.id !== excludeRunId,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return runs[0] ?? null;
  }

  async getOldestRunForSession(
    agentId: string,
    sessionId: string,
  ): Promise<{ id: string; createdAt: Date } | null> {
    const runs = Array.from(this.runs.values())
      .filter(
        (r) => r.agentId === agentId && r.sessionIdAfter === sessionId,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return runs[0] ? { id: runs[0].id, createdAt: runs[0].createdAt } : null;
  }

  // --- Session operations ---

  private sessionKey(
    tenantId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return `${tenantId}:${agentId}:${adapterType}:${taskKey}`;
  }

  async getTaskSession(
    tenantId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ): Promise<TaskSession | null> {
    return (
      this.taskSessions.get(
        this.sessionKey(tenantId, agentId, adapterType, taskKey),
      ) ?? null
    );
  }

  async upsertTaskSession(
    session: Partial<TaskSession> & {
      tenantId: string;
      agentId: string;
      adapterType: string;
      taskKey: string;
    },
  ): Promise<void> {
    const key = this.sessionKey(
      session.tenantId,
      session.agentId,
      session.adapterType,
      session.taskKey,
    );
    const existing = this.taskSessions.get(key);
    const now = new Date();
    if (existing) {
      Object.assign(existing, session, {
        updatedAt: now,
        runCount: (existing.runCount ?? 0) + 1,
      });
    } else {
      this.taskSessions.set(key, {
        id: randomUUID(),
        tenantId: session.tenantId,
        agentId: session.agentId,
        adapterType: session.adapterType,
        taskKey: session.taskKey,
        sessionParamsJson: session.sessionParamsJson ?? null,
        sessionDisplayId: session.sessionDisplayId ?? null,
        runCount: 1,
        totalRawInputTokens: 0,
        lastRunId: session.lastRunId ?? null,
        lastError: session.lastError ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async clearTaskSession(agentId: string, taskKey: string): Promise<void> {
    for (const [key, session] of this.taskSessions) {
      if (session.agentId === agentId && session.taskKey === taskKey) {
        this.taskSessions.delete(key);
      }
    }
  }

  // --- Runtime state ---

  async ensureRuntimeState(
    agentId: string,
    tenantId: string,
    adapterType: string,
  ): Promise<RuntimeState> {
    let state = this.runtimeStates.get(agentId);
    if (!state) {
      const now = new Date();
      state = {
        agentId,
        tenantId,
        adapterType,
        sessionId: null,
        stateJson: {},
        lastRunId: null,
        lastRunStatus: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedInputTokens: 0,
        totalCostCents: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      this.runtimeStates.set(agentId, state);
    }
    return { ...state };
  }

  async updateRuntimeState(
    agentId: string,
    patch: Partial<RuntimeState>,
  ): Promise<void> {
    const state = this.runtimeStates.get(agentId);
    if (!state) return;
    Object.assign(state, patch, { updatedAt: new Date() });
  }

  async accumulateUsage(agentId: string, usage: UsageDelta): Promise<void> {
    const state = this.runtimeStates.get(agentId);
    if (!state) return;
    state.totalInputTokens += usage.inputTokens;
    state.totalOutputTokens += usage.outputTokens;
    state.totalCachedInputTokens += usage.cachedInputTokens;
    state.updatedAt = new Date();
  }

  // --- Cost tracking ---

  async recordCost(event: CostEvent): Promise<void> {
    this.costEvents.push({ ...event, id: randomUUID(), createdAt: new Date() });
  }

  // --- Wakeup requests ---

  async createWakeupRequest(
    request: Omit<WakeupRequest, "id" | "createdAt" | "updatedAt">,
  ): Promise<WakeupRequest> {
    const now = new Date();
    const wr: WakeupRequest = {
      ...request,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.wakeupRequests.set(wr.id, wr);
    return wr;
  }

  async getWakeupRequest(id: string): Promise<WakeupRequest | null> {
    return this.wakeupRequests.get(id) ?? null;
  }

  async updateWakeupRequest(
    id: string,
    patch: Partial<WakeupRequest>,
  ): Promise<void> {
    const wr = this.wakeupRequests.get(id);
    if (!wr) return;
    Object.assign(wr, patch, { updatedAt: new Date() });
  }

  async getPendingWakeupRequests(agentId: string): Promise<WakeupRequest[]> {
    return Array.from(this.wakeupRequests.values()).filter(
      (wr) => wr.agentId === agentId && wr.status === "queued",
    );
  }

  // --- Utility ---

  getCostEvents(): CostEvent[] {
    return [...this.costEvents];
  }

  clear(): void {
    this.agents.clear();
    this.runs.clear();
    this.taskSessions.clear();
    this.runtimeStates.clear();
    this.costEvents = [];
    this.wakeupRequests.clear();
  }
}
