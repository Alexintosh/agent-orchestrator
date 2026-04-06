# Adapters API

## Importing Adapters

```typescript
// All adapters via convenience object
import { adapters } from "agent-orchestrator";
adapters.claudeLocal   // type: "claude_local"
adapters.codexLocal    // type: "codex_local"
adapters.cursorLocal   // type: "cursor"
adapters.geminiLocal   // type: "gemini_local"
adapters.opencodeLocal // type: "opencode_local"
adapters.piLocal       // type: "pi_local"
adapters.openclawGateway // type: "openclaw_gateway"

// Individual named exports
import {
  claudeLocalAdapter,
  codexLocalAdapter,
  cursorLocalAdapter,
  geminiLocalAdapter,
  opencodeLocalAdapter,
  piLocalAdapter,
  openclawGatewayAdapter,
} from "agent-orchestrator";

// Tree-shakeable subpath imports
import { claudeLocalAdapter } from "agent-orchestrator/adapters/claude-local";
```

## AdapterRegistry

The registry maps type strings to adapter modules.

### `registry.register(adapter)`
Register a new adapter module.

### `registry.get(type): ServerAdapterModule`
Get an adapter by type. Throws if not found.

### `registry.find(type): ServerAdapterModule | null`
Find an adapter by type. Returns `null` if not found.

### `registry.listTypes(): string[]`
List all registered adapter type strings.

### `registry.listAll(): ServerAdapterModule[]`
List all registered adapter modules.

### `registry.listModels(type): Promise<AdapterModel[]>`
List models for a specific adapter type.

### `registry.listAllModels(): Promise<Array<{ adapterType: string; models: AdapterModel[] }>>`
List models across all registered adapters.

## AdapterExecutionContext

What the adapter receives when `execute()` is called:

```typescript
interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  authToken?: string;
}
```

| Field | Description |
|-------|-------------|
| `runId` | Unique run identifier |
| `agent` | Agent metadata (id, name, tenantId, adapterType, adapterConfig) |
| `runtime` | Session state (sessionId, sessionParams, taskKey) |
| `config` | Resolved adapter configuration |
| `context` | Full context snapshot (workspace, wake reason, etc.) |
| `onLog` | Callback for streaming stdout/stderr chunks |
| `authToken` | Short-lived JWT for API callbacks |

## AdapterExecutionResult

What the adapter returns after execution:

```typescript
interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  usage?: UsageSummary;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown>;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  billingType?: "api" | "subscription" | "unknown";
  costUsd?: number | null;
  resultJson?: Record<string, unknown>;
  clearSession?: boolean;
  summary?: string | null;
}
```

## AdapterModel

```typescript
interface AdapterModel {
  id: string;
  name?: string;
  provider?: string;
  description?: string;
}
```
