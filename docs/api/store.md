# Store Interface

The `OrchestratorStore` interface defines all persistence operations. Implement this to use any database backend.

## Interface

```typescript
interface OrchestratorStore {
  // --- Agent ---
  getAgent(id: string): Promise<Agent | null>;
  updateAgent(id: string, patch: Partial<Agent>): Promise<void>;
  createAgent(agent: Omit<Agent, "createdAt" | "updatedAt">): Promise<Agent>;

  // --- Runs ---
  createRun(input: NewRun): Promise<Run>;
  claimRun(runId: string): Promise<Run | null>;
  updateRun(runId: string, patch: Partial<Run>): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  getQueuedRuns(agentId: string, limit: number): Promise<Run[]>;
  getRunningCount(agentId: string): Promise<number>;
  getLatestRunForSession(
    agentId: string, sessionId: string, excludeRunId?: string
  ): Promise<Run | null>;
  getOldestRunForSession(
    agentId: string, sessionId: string
  ): Promise<{ id: string; createdAt: Date } | null>;

  // --- Sessions ---
  getTaskSession(
    tenantId: string, agentId: string,
    adapterType: string, taskKey: string
  ): Promise<TaskSession | null>;
  upsertTaskSession(session: Partial<TaskSession> & {
    tenantId: string; agentId: string;
    adapterType: string; taskKey: string;
  }): Promise<void>;
  clearTaskSession(agentId: string, taskKey: string): Promise<void>;

  // --- Runtime State ---
  ensureRuntimeState(
    agentId: string, tenantId: string, adapterType: string
  ): Promise<RuntimeState>;
  updateRuntimeState(
    agentId: string, patch: Partial<RuntimeState>
  ): Promise<void>;
  accumulateUsage(agentId: string, usage: UsageDelta): Promise<void>;

  // --- Cost Tracking ---
  recordCost(event: CostEvent): Promise<void>;

  // --- Wakeup Requests ---
  createWakeupRequest(
    request: Omit<WakeupRequest, "id" | "createdAt" | "updatedAt">
  ): Promise<WakeupRequest>;
  getWakeupRequest(id: string): Promise<WakeupRequest | null>;
  updateWakeupRequest(
    id: string, patch: Partial<WakeupRequest>
  ): Promise<void>;
  getPendingWakeupRequests(agentId: string): Promise<WakeupRequest[]>;
}
```

## Built-in: MemoryStore

```typescript
import { MemoryStore } from "agent-orchestrator";

const store = new MemoryStore();

// Additional utility methods (not in interface):
store.getCostEvents();  // Get all recorded cost events
store.clear();          // Clear all data
```

## Implementation Notes

### Atomicity

`claimRun()` must atomically check `status = 'queued'` and update to `'running'`. Use database row-level locking or compare-and-swap. The `MemoryStore` implementation is safe for single-process only.

### Session Upsert

`upsertTaskSession()` should increment `runCount` on update (not replace it). The `MemoryStore` does this automatically.

### Usage Accumulation

`accumulateUsage()` adds token deltas to the running totals — it should use atomic increment operations in production:

```sql
UPDATE agent_runtime_state
SET total_input_tokens = total_input_tokens + $1,
    total_output_tokens = total_output_tokens + $2,
    total_cached_input_tokens = total_cached_input_tokens + $3
WHERE agent_id = $4;
```
