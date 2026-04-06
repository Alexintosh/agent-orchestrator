# Storage

All orchestrator state is persisted through the `OrchestratorStore` interface. This makes the library database-agnostic.

## MemoryStore

Included for testing and simple use cases:

```typescript
import { MemoryStore } from "agent-orchestrator";

const store = new MemoryStore();
const orchestrator = createOrchestrator({ store });
```

::: warning
MemoryStore loses all data on process exit. Use a persistent store for production.
:::

## Implementing a Custom Store

Implement the `OrchestratorStore` interface to use any database:

```typescript
import type { OrchestratorStore } from "agent-orchestrator";

class PostgresStore implements OrchestratorStore {
  constructor(private db: Pool) {}

  async getAgent(id: string) {
    const result = await this.db.query(
      "SELECT * FROM agents WHERE id = $1", [id]
    );
    return result.rows[0] ?? null;
  }

  async createRun(input: NewRun) {
    const result = await this.db.query(
      "INSERT INTO runs (...) VALUES (...) RETURNING *",
      [...]
    );
    return result.rows[0];
  }

  async claimRun(runId: string) {
    // Atomic transition: queued → running
    const result = await this.db.query(
      `UPDATE runs SET status = 'running', started_at = NOW()
       WHERE id = $1 AND status = 'queued'
       RETURNING *`,
      [runId]
    );
    return result.rows[0] ?? null;
  }

  // ... implement remaining methods
}
```

## Store Interface

The full interface has ~20 methods across 6 categories:

### Agent Operations
- `getAgent(id)` — fetch an agent by ID
- `updateAgent(id, patch)` — update agent fields
- `createAgent(agent)` — create a new agent

### Run Operations
- `createRun(input)` — create a queued run
- `claimRun(runId)` — atomically claim a queued run
- `updateRun(runId, patch)` — update run fields
- `getRun(runId)` — fetch a run by ID
- `getQueuedRuns(agentId, limit)` — list queued runs for an agent
- `getRunningCount(agentId)` — count running runs

### Session Operations
- `getTaskSession(tenantId, agentId, adapterType, taskKey)` — fetch a session
- `upsertTaskSession(session)` — create or update a session
- `clearTaskSession(agentId, taskKey)` — delete a session

### Runtime State
- `ensureRuntimeState(agentId, tenantId, adapterType)` — get or create runtime state
- `updateRuntimeState(agentId, patch)` — update runtime state
- `accumulateUsage(agentId, usage)` — add token usage to totals

### Cost Tracking
- `recordCost(event)` — record a cost event

### Wakeup Requests
- `createWakeupRequest(request)` — create a wakeup
- `getWakeupRequest(id)` — fetch a wakeup
- `updateWakeupRequest(id, patch)` — update a wakeup
- `getPendingWakeupRequests(agentId)` — list pending wakeups

## Critical: Atomic `claimRun`

The `claimRun` method must be **atomic** — it should use a database-level compare-and-swap to prevent two workers from claiming the same run. In SQL:

```sql
UPDATE runs
SET status = 'running', started_at = NOW()
WHERE id = $1 AND status = 'queued'
RETURNING *;
```

The `MemoryStore` implementation is not safe for multi-process use. For production with multiple workers, use a database-backed store with proper row-level locking.
