# createOrchestrator

The main factory function that wires together all orchestrator components.

## Signature

```typescript
function createOrchestrator(opts?: OrchestratorOptions): Orchestrator
```

## Options

```typescript
interface OrchestratorOptions {
  /** Storage backend. Defaults to MemoryStore. */
  store?: OrchestratorStore;

  /** Adapter modules to register. */
  adapters?: ServerAdapterModule[];

  /** Workspace resolution strategy. */
  workspace?:
    | WorkspaceResolver
    | { defaultCwd: string; agentWorkspaceBase?: string };

  /** Auth provider for agent JWT tokens. */
  auth?: AuthProvider | { secret: string; ttlSeconds?: number };

  /** Run log storage. Defaults to NullRunLogger. */
  runLogger?: RunLogger;

  /** Structured logger. Defaults to console. */
  logger?: Logger;
}
```

## Returns: Orchestrator

### `executeRun(runId: string): Promise<AdapterExecutionResult | null>`

Execute a run by ID. The run must be in `queued` status.

### `invoke(agentId: string, opts?: WakeupOptions): Promise<Run | null>`

Queue a run for an agent and start executing it. Returns `null` if the agent is already at max concurrency.

```typescript
const run = await orchestrator.invoke(agentId, {
  source: "on_demand",
  prompt: "Do the thing",
  taskKey: "my-task",
  context: { issueId: "123" },
});
```

**WakeupOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Invocation source (e.g., `"on_demand"`, `"heartbeat"`) |
| `prompt` | `string` | Initial prompt for the agent |
| `taskKey` | `string` | Session grouping key |
| `context` | `Record<string, unknown>` | Additional context passed to the adapter |
| `triggerDetail` | `TriggerDetail` | Trigger metadata (e.g., webhook payload) |

### `registerAgent(agent): Promise<Agent>`

Register a new agent configuration.

```typescript
const agent = await orchestrator.registerAgent({
  name: "my-agent",
  tenantId: "co",
  adapterType: "claude_local",
  adapterConfig: { model: "sonnet" },
  runtimeConfig: { maxConcurrentRuns: 1 },
});
```

### `cancelRun(runId: string): Promise<boolean>`

Cancel a queued run. Returns `true` if the run was cancelled.

### `start(intervalMs?: number): void`

Start the scheduler timer. Default interval is 60,000ms.

### `stop(): void`

Stop the scheduler timer.

### `tickTimers(): Promise<void>`

Manually trigger a scheduler tick.

### `listModels(): Promise<Array<{ adapterType: string; models: AdapterModel[] }>>`

List available models across all registered adapters.

### `on(event, listener): void`

Subscribe to orchestrator events.

### `off(event, listener): void`

Unsubscribe from events.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `store` | `OrchestratorStore` | The underlying store |
| `registry` | `AdapterRegistry` | The adapter registry |
| `events` | `EventEmitter` | The event emitter |

## Events

| Event | Payload | When |
|-------|---------|------|
| `run.queued` | `(run: Run)` | Run created and queued |
| `run.started` | `(run: Run)` | Run claimed and executing |
| `run.completed` | `(run: Run)` | Run finished successfully |
| `run.failed` | `(run: Run)` | Run failed with error |
| `run.cancelled` | `(run: Run)` | Run was cancelled |
| `session.rotated` | `(agentId: string, reason: string)` | Session was rotated |

## Example

```typescript
import {
  createOrchestrator,
  adapters,
  MemoryStore,
  DefaultAuth,
  DefaultRunLogger,
} from "agent-orchestrator";

const orchestrator = createOrchestrator({
  store: new MemoryStore(),
  adapters: [adapters.claudeLocal, adapters.geminiLocal],
  workspace: { defaultCwd: "/workspace" },
  auth: new DefaultAuth({ secret: "my-secret", ttlSeconds: 300 }),
  runLogger: new DefaultRunLogger({ dir: "/var/log/agent-runs" }),
});
```
