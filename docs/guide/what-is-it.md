# What is Agent Orchestrator?

Agent Orchestrator is a standalone TypeScript library for scheduling, executing, and managing sessions for CLI-based AI agents. It provides a unified runtime that supports multiple agent backends — Claude, Codex, Gemini, Cursor, OpenCode, Pi, and OpenClaw — through a pluggable adapter architecture.

## The Problem

Running AI agents in production involves more than just spawning a CLI process:

- **Session management** — agents need to resume conversations, not start fresh every time
- **Scheduling** — heartbeats, timers, and on-demand invocations need orchestration
- **Concurrency** — multiple agents shouldn't clobber each other's workspaces
- **Cost tracking** — token usage and API costs need to be recorded per run
- **Multi-runtime** — different tasks may need different agent backends

## The Solution

Agent Orchestrator provides a single `createOrchestrator()` factory that wires together:

```
┌─────────────────────────────────────────────────────┐
│                    Scheduler                         │
│  (Timer ticks, on-demand wakeups, concurrency)      │
├─────────────────────────────────────────────────────┤
│                   Run Executor                       │
│  (15-step pipeline: claim → dispatch → persist)     │
├─────────────────────────────────────────────────────┤
│                 Adapter Registry                     │
│  (Adapter lookup, model listing)                    │
├───────┬───────┬───────┬───────┬───────┬─────┬───────┤
│Claude │ Codex │Cursor │Gemini │OpenCd │ Pi  │OClaw  │
└───────┴───────┴───────┴───────┴───────┴─────┴───────┘
```

## Key Design Decisions

### Storage Abstraction

All persistence goes through the `OrchestratorStore` interface. Use the included `MemoryStore` for testing, or implement the interface with your database of choice (Postgres, SQLite, Redis, etc.).

### Adapter Pattern

Each agent runtime is a `ServerAdapterModule` with `execute()` and `testEnvironment()` methods. The orchestrator doesn't know how to talk to Claude or Gemini directly — it delegates to the adapter, which handles CLI invocation, output parsing, and session serialization.

### Event-Driven

All lifecycle events (`run.started`, `run.completed`, `run.failed`, `session.rotated`) are emitted through a typed event emitter, so you can build monitoring, logging, or webhooks on top.

## When to Use This

- **You're building a platform that runs multiple AI agents** and need scheduling, session tracking, and cost monitoring
- **You want to support multiple AI runtimes** (Claude + Codex + Gemini) behind a unified API
- **You need session persistence** — agents that remember previous conversations and resume where they left off
- **You want to self-host** agent orchestration without depending on a SaaS platform
