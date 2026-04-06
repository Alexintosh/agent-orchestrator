# Getting Started

## Installation

```bash
npm install agent-orchestrator
```

## Quick Start

```typescript
import {
  createOrchestrator,
  claudeLocalAdapter,
  MemoryStore,
} from "agent-orchestrator";

// 1. Create an orchestrator
const orchestrator = createOrchestrator({
  store: new MemoryStore(),
  adapters: [claudeLocalAdapter],
  workspace: { defaultCwd: "/path/to/workspace" },
});

// 2. Register an agent
const agent = await orchestrator.registerAgent({
  name: "my-agent",
  tenantId: "my-company",
  adapterType: "claude_local",
  adapterConfig: {
    model: "sonnet",
    dangerouslySkipPermissions: true,
  },
});

// 3. Invoke the agent
const run = await orchestrator.invoke(agent.id, {
  source: "on_demand",
  prompt: "Hello, what can you do?",
});

// 4. Listen for completion
orchestrator.on("run.completed", (completedRun) => {
  console.log(`Run finished: ${completedRun.status}`);
});
```

## Prerequisites

Each adapter requires its corresponding CLI tool to be installed:

| Adapter | CLI Tool | Auth |
|---------|----------|------|
| `claudeLocalAdapter` | `claude` | `ANTHROPIC_API_KEY` or `claude login` |
| `codexLocalAdapter` | `codex` | `OPENAI_API_KEY` |
| `cursorLocalAdapter` | `cursor` | `CURSOR_API_KEY` |
| `geminiLocalAdapter` | `gemini` | `GEMINI_API_KEY` |
| `opencodeLocalAdapter` | `opencode` | Provider-specific |
| `piLocalAdapter` | `pi` | Built-in auth |
| `openclawGatewayAdapter` | N/A (WebSocket) | Device identity + API key |

## Using Multiple Adapters

```typescript
import {
  createOrchestrator,
  adapters,
  MemoryStore,
} from "agent-orchestrator";

const orchestrator = createOrchestrator({
  store: new MemoryStore(),
  adapters: Object.values(adapters), // Register all 7
  workspace: { defaultCwd: process.cwd() },
});

// Now you can register agents with any adapter type
const claudeAgent = await orchestrator.registerAgent({
  name: "claude-agent",
  tenantId: "co",
  adapterType: "claude_local",
  adapterConfig: { model: "sonnet" },
});

const geminiAgent = await orchestrator.registerAgent({
  name: "gemini-agent",
  tenantId: "co",
  adapterType: "gemini_local",
  adapterConfig: { model: "gemini-2.5-pro" },
});
```

## Tree-Shakeable Imports

If you only need one adapter, import it directly to keep your bundle small:

```typescript
import { claudeLocalAdapter } from "agent-orchestrator/adapters/claude-local";
```

## Next Steps

- [Architecture](/guide/architecture) — understand the execution pipeline
- [Adapters](/guide/adapters) — deep dive into adapter configuration
- [Sessions](/guide/sessions) — learn about session persistence and compaction
- [API Reference](/api/orchestrator) — full `createOrchestrator` API
