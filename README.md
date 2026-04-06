# agent-orchestrator

Standalone library for scheduling, executing, and managing sessions for CLI-based AI agents. Supports Claude, Codex, Gemini, Cursor, OpenCode, Pi, and OpenClaw out of the box.

## Installation

```bash
npm install agent-orchestrator
```

Requires **Node.js 20+**.

## Quick Start

```typescript
import {
  createOrchestrator,
  claudeLocalAdapter,
  MemoryStore,
} from "agent-orchestrator";

const orchestrator = createOrchestrator({
  store: new MemoryStore(),
  adapters: [claudeLocalAdapter],
  workspace: { defaultCwd: "/path/to/workspace" },
});

const agent = await orchestrator.registerAgent({
  name: "my-agent",
  adapterType: "claude_local",
  adapterConfig: {
    model: "sonnet",
    dangerouslySkipPermissions: true,
  },
});

const run = await orchestrator.invoke(agent.id, {
  source: "on_demand",
  prompt: "Hello, what can you do?",
});
```

## Bundled Adapters

| Adapter | CLI Tool | Auth |
|---------|----------|------|
| `claudeLocalAdapter` | `claude` | `ANTHROPIC_API_KEY` or `claude login` |
| `codexLocalAdapter` | `codex` | `OPENAI_API_KEY` |
| `cursorLocalAdapter` | `cursor` | `CURSOR_API_KEY` |
| `geminiLocalAdapter` | `gemini` | `GEMINI_API_KEY` |
| `opencodeLocalAdapter` | `opencode` | Provider-specific |
| `piLocalAdapter` | `pi` | Built-in auth |
| `openclawGatewayAdapter` | N/A (WebSocket) | Device identity + API key |

Register all adapters at once:

```typescript
import { adapters } from "agent-orchestrator";

const orchestrator = createOrchestrator({
  store: new MemoryStore(),
  adapters: Object.values(adapters),
  workspace: { defaultCwd: process.cwd() },
});
```

Or import individually for tree-shaking:

```typescript
import { claudeLocalAdapter } from "agent-orchestrator/adapters/claude-local";
```

## Key Concepts

- **Adapters** bridge the orchestrator to CLI-based agents. Each implements `ServerAdapterModule`.
- **Sessions** persist agent context across runs, tracked per (agent, adapter, taskKey). Automatic compaction rotates sessions when they grow too large.
- **Scheduler** queues and executes runs with concurrency control.
- **Store** is pluggable. `MemoryStore` ships for testing; implement `OrchestratorStore` for production (e.g., PostgreSQL).
- **Tenant isolation** via `tenantId` (optional, defaults to `"default"` for single-tenant use).

## Running the Examples

The examples live in the `examples/` directory. Run them with `tsx`:

```bash
# Install tsx if you don't have it
npm install -g tsx
```

### Example 1: Single Agent Runner

Registers a Claude agent, invokes it with a prompt, and prints the result.

**Prerequisites:** `claude` CLI installed and authenticated (`ANTHROPIC_API_KEY` or `claude login`).

```bash
npx tsx examples/01-single-agent-runner.ts
```

### Example 2: Multi-Session Resume

Demonstrates session persistence across multiple runs using a mock adapter (no CLI tools required):
- Run 1: Agent starts a fresh session
- Run 2: Same taskKey resumes the session
- Run 3: Different taskKey starts a new session
- Run 4: Returns to the original session

```bash
npx tsx examples/02-multi-session-resume.ts
```

### Example 3: Agent Identity from Markdown

Shows how to give an agent a full identity via a markdown file — defining its role, personality, rules, and output format. Demonstrates two approaches:

- **`instructionsFilePath`** — the agent identity is injected as a system prompt extension (recommended for Claude)
- **`promptTemplate`** — the identity is embedded directly in the prompt (works with all adapters)

The example creates a code review agent and asks it to review a deliberately insecure login handler.

**Prerequisites:** `claude` CLI installed and authenticated.

```bash
npx tsx examples/03-agent-identity-from-markdown.ts
```

## Development

```bash
# Build
npm run build

# Type-check
npm run check

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Documentation site (VitePress)
npm run docs:dev       # dev server
npm run docs:build     # production build
```

## Documentation

Full API reference and guides are available via VitePress:

```bash
npm run docs:dev
```

Covers architecture, adapter configuration, session management, storage backends, and custom adapter development.

## License

MIT

## Acknowledgements

This library was extracted from [Paperclip](https://paperclip.com)'s agent orchestration platform. The core execution pipeline, adapter pattern, session management system, and scheduler were originally developed as part of Paperclip's multi-agent infrastructure for coordinating CLI-based AI agents at scale.
