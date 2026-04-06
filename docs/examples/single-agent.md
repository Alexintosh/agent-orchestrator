# Single Agent Runner

A minimal example that registers one Claude agent, invokes it, and prints the result.

## Full Source

<<< @/../examples/01-single-agent-runner.ts

## Running

```bash
npx tsx examples/01-single-agent-runner.ts
```

## Prerequisites

- `claude` CLI installed and authenticated
- `ANTHROPIC_API_KEY` set, or `claude login` completed

## What This Demonstrates

1. **Creating an orchestrator** with `MemoryStore` and a single adapter
2. **Registering an agent** with adapter-specific config
3. **Subscribing to events** (`run.started`, `run.completed`, `run.failed`)
4. **Invoking the agent** and waiting for completion
5. **Reading run results** (status, usage, stdout excerpt)

## Key Points

- `MemoryStore` is used for simplicity — all data lives in memory
- `dangerouslySkipPermissions: true` lets the agent run without interactive prompts
- `maxTurns: 1` limits the agent to a single response
- The polling loop waits for the run to finish; in production, use events instead
