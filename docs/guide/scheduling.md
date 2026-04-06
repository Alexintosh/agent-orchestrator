# Scheduling

The orchestrator includes a built-in scheduler for timer-based heartbeats and on-demand invocations.

## On-Demand Invocation

The simplest way to run an agent:

```typescript
const run = await orchestrator.invoke(agentId, {
  source: "on_demand",
  prompt: "Review the latest PR",
  taskKey: "pr-review-123",
});
```

This creates a wakeup request, queues a run, and executes it immediately.

## Timer-Based Scheduling

For recurring agent execution, use the scheduler's timer:

```typescript
// Start the scheduler (ticks every 60 seconds by default)
orchestrator.start(60_000);

// Or tick manually
await orchestrator.tickTimers();

// Stop when done
orchestrator.stop();
```

Each tick checks for pending wakeup requests and starts queued runs.

## Concurrency Control

The scheduler ensures only one run executes per agent at a time (by default). If a run is already in progress, new invocations are queued:

```typescript
// These won't run simultaneously — second is queued
await orchestrator.invoke(agentId, { source: "on_demand", prompt: "Task A" });
await orchestrator.invoke(agentId, { source: "on_demand", prompt: "Task B" });
```

## Run Lifecycle

```
  invoke()
     │
     ▼
  ┌──────┐    claimRun()    ┌─────────┐    adapter.execute()    ┌───────────┐
  │queued │ ──────────────→ │ running  │ ─────────────────────→ │ completed │
  └──────┘                  └─────────┘                         └───────────┘
     │                          │
     │                          │  on error
     │                          ▼
     │                     ┌──────────┐
     │                     │  failed  │
     │                     └──────────┘
     │
     │  cancelRun()
     ▼
  ┌───────────┐
  │ cancelled │
  └───────────┘
```

## Cancelling Runs

```typescript
const cancelled = await orchestrator.cancelRun(runId);
```

This transitions a queued run to `cancelled`. Running runs are not interrupted (the underlying CLI process continues), but the run is marked for cancellation.

## Events

Monitor scheduling activity through events:

```typescript
orchestrator.on("run.queued", (run) => {
  console.log(`Queued: ${run.id}`);
});

orchestrator.on("run.started", (run) => {
  console.log(`Started: ${run.id}`);
});

orchestrator.on("run.completed", (run) => {
  console.log(`Completed: ${run.id} (exit: ${run.exitCode})`);
});

orchestrator.on("run.failed", (run) => {
  console.error(`Failed: ${run.id} — ${run.error}`);
});
```
