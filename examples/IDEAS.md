# Example Ideas

Backlog of examples to build, covering all major library features.

## Existing

- [x] **01 — Single Agent Runner** — Hello world: register, invoke, print result
- [x] **02 — Multi-Session Resume** — Session persistence across runs with mock adapter
- [x] **03 — Agent Identity from Markdown** — Full agent identity via `instructionsFilePath` and `promptTemplate`

## Scheduling & Lifecycle

- [ ] **04 — Scheduled Heartbeat Agent** — Register an agent with a recurring timer, use `orchestrator.start()` / `tickTimers()` to fire it on an interval. Shows the scheduler loop, concurrency limits, and `run.queued` / `run.started` / `run.completed` event lifecycle.
- [ ] **05 — Cancelling a Run** — Invoke a long-running agent, then call `cancelRun()` mid-execution. Demonstrates graceful termination and the `run.failed` event with cancellation reason.
- [ ] **06 — Concurrency & Queuing** — Invoke the same agent multiple times in rapid succession. Shows how the scheduler queues runs and executes them serially (or with a configured concurrency limit).

## Sessions & Context

- [ ] **07 — Session Compaction & Rotation** — Configure `sessionCompaction` with a low `maxSessionRuns` threshold. Run an agent enough times to trigger automatic rotation, showing the handoff summary injection into the next session.
- [ ] **08 — Task-Scoped Sessions** — Multiple agents working on different tasks (e.g., issues), each with independent session state. Shows how `taskKey` isolates conversations.

## Multi-Agent & Multi-Adapter

- [ ] **09 — Multi-Adapter Fleet** — Register agents across 3+ adapters (Claude, Codex, Gemini), invoke them all, and compare results. Shows `adapters` convenience import, `listModels()`, and adapter-specific config differences.
- [ ] **10 — Agent Delegation Chain** — One agent's output feeds into another agent's prompt. Manual fan-out pattern: run agent A, extract result, invoke agent B with that context.

## Storage & Persistence

- [ ] **11 — Custom Store Implementation** — Implement a simple SQLite-backed `OrchestratorStore`, register agents, run them, restart the process, and show runs/sessions survived the restart.
- [ ] **12 — Run Log Streaming** — Use `DefaultRunLogger` to write NDJSON logs to disk, then read them back. Shows `runLogger.begin()` / `handle.append()` / `handle.finalize()` and the log format.

## Auth & Security

- [ ] **13 — JWT Auth for Agent-to-API Callbacks** — Configure `DefaultAuth` with a secret, register an agent, and show how the executor generates a short-lived JWT that the agent can use to call back into your API. Demonstrates `AuthProvider.createToken()` / `verifyToken()`.

## Adapters

- [ ] **14 — Custom Adapter** — Build a minimal adapter from scratch (e.g., wrapping a simple shell script or HTTP API). Implements `ServerAdapterModule` with `execute()`, `testEnvironment()`, and a session codec.
- [ ] **15 — Environment Pre-flight Checks** — Call `testEnvironment()` on each registered adapter before running anything. Shows how to validate CLI tools are installed, API keys are set, etc.

## Events & Observability

- [ ] **16 — Event-Driven Dashboard** — Subscribe to all event types (`run.queued`, `run.started`, `run.completed`, `run.failed`, `session.rotated`) and build a live console dashboard with run counts, success rates, and token usage.

## Cost & Usage Tracking

- [ ] **17 — Budget-Aware Agent** — Set `budgetMonthlyCents` on an agent, run it, and show how `recordCost()` and `accumulateUsage()` track spend. Demonstrate reading cumulative usage from runtime state.
