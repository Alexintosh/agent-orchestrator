# Architecture

## Run Execution Pipeline

Every agent invocation follows a 15-step pipeline inside `executeRun()`:

```
 1. CLAIM           Atomically transition run: queued → running
 2. RESOLVE AGENT   Fetch agent record, ensure runtime state
 3. RESOLVE TASK    Derive taskKey from context (issueId, taskId, etc.)
 4. RESOLVE WORKSPACE  Project workspace → task session → agent home
 5. RESOLVE SESSION Load previous session, check compaction policy
 6. RESOLVE CONFIG  Merge adapterConfig + overrides
 7. REALIZE WORKSPACE  Create directories, prepare environment
 8. GENERATE AUTH   Create JWT if adapter supports it
 9. DISPATCH        Call adapter.execute(ctx)
10. PROCESS RESULT  Extract usage, session, costs from result
11. PERSIST SESSION Upsert task session with new params
12. RECORD COSTS    Insert cost event, update spend totals
13. UPDATE STATE    Accumulate totals in runtime state
14. RELEASE LOCKS   Release task execution locks
15. FINALIZE        Set run status, emit events, start next queued
```

## Component Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     Orchestrator                          │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │Scheduler │→ │ Executor │→ │   Adapter Registry    │  │
│  │          │  │          │  │                       │  │
│  │ timers   │  │ 15-step  │  │ ┌───────┐ ┌───────┐  │  │
│  │ wakeups  │  │ pipeline │  │ │Claude │ │Codex  │  │  │
│  │ queuing  │  │          │  │ ├───────┤ ├───────┤  │  │
│  └──────────┘  └────┬─────┘  │ │Cursor │ │Gemini │  │  │
│                     │        │ ├───────┤ ├───────┤  │  │
│                     ▼        │ │OpenCd │ │  Pi   │  │  │
│              ┌─────────────┐ │ ├───────┤ └───────┘  │  │
│              │   Session   │ │ │OClaw  │            │  │
│              │  Manager    │ │ └───────┘            │  │
│              └─────────────┘ └───────────────────────┘  │
│                                                          │
├──────────────────── Interfaces ──────────────────────────┤
│                                                          │
│  OrchestratorStore    WorkspaceResolver    AuthProvider   │
│  RunLogger            EventEmitter         Logger        │
└──────────────────────────────────────────────────────────┘
```

## Pluggable Interfaces

The orchestrator is decoupled from infrastructure through these interfaces:

### OrchestratorStore

All persistence — agents, runs, sessions, runtime state, costs, wakeup requests. Implement this to use any database.

```typescript
interface OrchestratorStore {
  getAgent(id: string): Promise<Agent | null>;
  createRun(run: NewRun): Promise<Run>;
  claimRun(runId: string): Promise<Run | null>;
  getTaskSession(...): Promise<TaskSession | null>;
  upsertTaskSession(session: ...): Promise<void>;
  // ... 20+ methods
}
```

### WorkspaceResolver

Determines where each agent runs (CWD). The default `SimpleWorkspaceResolver` uses a configured directory; implement your own for git worktrees, containers, etc.

### AuthProvider

Generates short-lived tokens for agents to call back to your API. Default implementation uses HS256 JWT. Use `NoAuth` if agents don't need tokens.

### RunLogger

Records per-run NDJSON logs. `DefaultRunLogger` writes to local files; `NullRunLogger` discards everything.

## Data Flow

```
invoke(agentId) → scheduler.invoke()
  → store.createWakeupRequest()
  → store.createRun()
  → executeRun(runId)
    → store.claimRun()
    → adapter.execute(ctx)
      → spawns CLI process
      → streams stdout/stderr → onLog()
      → returns AdapterExecutionResult
    → store.upsertTaskSession()
    → store.recordCost()
    → store.updateRun()
    → events.emit("run.completed")
    → scheduler.startNextQueued()
```
