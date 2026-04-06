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

/**
 * Storage abstraction for the orchestrator.
 * Implement this interface to back the orchestrator with any database.
 */
export interface OrchestratorStore {
  // --- Agent operations ---
  getAgent(id: string): Promise<Agent | null>;
  updateAgent(id: string, patch: Partial<Agent>): Promise<void>;
  createAgent(agent: Omit<Agent, "createdAt" | "updatedAt">): Promise<Agent>;

  // --- Run operations ---
  createRun(run: NewRun): Promise<Run>;
  /** Atomically transition run from queued → running. Returns null if already claimed. */
  claimRun(runId: string): Promise<Run | null>;
  updateRun(runId: string, patch: Partial<Run>): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  getQueuedRuns(agentId: string, limit: number): Promise<Run[]>;
  getRunningCount(agentId: string): Promise<number>;
  getLatestRunForSession(agentId: string, sessionId: string, excludeRunId?: string): Promise<Run | null>;
  getOldestRunForSession(agentId: string, sessionId: string): Promise<{ id: string; createdAt: Date } | null>;

  // --- Session operations ---
  getTaskSession(
    tenantId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ): Promise<TaskSession | null>;
  upsertTaskSession(session: Partial<TaskSession> & {
    tenantId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
  }): Promise<void>;
  clearTaskSession(agentId: string, taskKey: string): Promise<void>;

  // --- Runtime state ---
  ensureRuntimeState(agentId: string, tenantId: string, adapterType: string): Promise<RuntimeState>;
  updateRuntimeState(agentId: string, patch: Partial<RuntimeState>): Promise<void>;
  accumulateUsage(agentId: string, usage: UsageDelta): Promise<void>;

  // --- Cost tracking ---
  recordCost(event: CostEvent): Promise<void>;

  // --- Wakeup requests ---
  createWakeupRequest(request: Omit<WakeupRequest, "id" | "createdAt" | "updatedAt">): Promise<WakeupRequest>;
  getWakeupRequest(id: string): Promise<WakeupRequest | null>;
  updateWakeupRequest(id: string, patch: Partial<WakeupRequest>): Promise<void>;
  getPendingWakeupRequests(agentId: string): Promise<WakeupRequest[]>;
}
