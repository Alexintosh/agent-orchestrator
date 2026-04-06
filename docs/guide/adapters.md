# Adapters

Adapters are the bridge between the orchestrator and CLI-based AI agents. Each adapter implements the `ServerAdapterModule` interface.

## Bundled Adapters

| Adapter | Type String | CLI | Output Format |
|---------|------------|-----|---------------|
| `claudeLocalAdapter` | `claude_local` | `claude` | Stream JSON |
| `codexLocalAdapter` | `codex_local` | `codex` | JSONL |
| `cursorLocalAdapter` | `cursor` | `cursor` | JSONL |
| `geminiLocalAdapter` | `gemini_local` | `gemini` | JSONL |
| `opencodeLocalAdapter` | `opencode_local` | `opencode` | JSONL |
| `piLocalAdapter` | `pi_local` | `pi` | JSONL |
| `openclawGatewayAdapter` | `openclaw_gateway` | WebSocket | WS frames |

## The Adapter Contract

```typescript
interface ServerAdapterModule {
  /** Unique type identifier (e.g., "claude_local") */
  type: string;

  /** Execute an agent run */
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;

  /** Check if the environment is properly configured */
  testEnvironment(
    ctx: AdapterEnvironmentTestContext
  ): Promise<AdapterEnvironmentTestResult>;

  /** Optional session serialization codec */
  sessionCodec?: AdapterSessionCodec;

  /** Static model list */
  models?: AdapterModel[];

  /** Dynamic model discovery */
  listModels?: () => Promise<AdapterModel[]>;
}
```

## Adapter Configuration

Each agent's `adapterConfig` is passed to the adapter at execution time:

```typescript
await orchestrator.registerAgent({
  name: "my-agent",
  tenantId: "co",
  adapterType: "claude_local",
  adapterConfig: {
    model: "opus",                        // Model selection
    maxTurns: 50,                         // Max conversation turns
    dangerouslySkipPermissions: true,     // Skip CLI permission prompts
    systemPrompt: "You are a code reviewer.",
    allowedTools: ["Read", "Grep", "Glob"],
  },
});
```

### Common Config Fields

These fields are supported by most CLI adapters:

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model ID to use |
| `maxTurns` | `number` | Maximum conversation turns |
| `dangerouslySkipPermissions` | `boolean` | Skip interactive permission prompts |
| `systemPrompt` | `string` | Override the system prompt |
| `allowedTools` | `string[]` | Restrict available tools |
| `timeout` | `number` | Execution timeout in ms |
| `cwd` | `string` | Override working directory |

## Writing a Custom Adapter

```typescript
import type {
  ServerAdapterModule,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "agent-orchestrator";

export const myAdapter: ServerAdapterModule = {
  type: "my_custom_agent",

  async execute(ctx) {
    await ctx.onLog("stdout", "Starting execution...\n");

    // Your execution logic here
    // e.g., HTTP API call, process spawn, etc.

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
      sessionParams: { conversationId: "abc-123" },
    };
  },

  async testEnvironment(ctx) {
    return {
      status: "pass",
      checks: [
        { name: "api_reachable", level: "required", status: "pass" },
      ],
    };
  },

  sessionCodec: {
    deserialize: (raw) => (raw as Record<string, unknown>) ?? null,
    serialize: (params) => params,
  },

  models: [
    { id: "my-model-v1", name: "My Model v1" },
  ],
};
```

## Environment Testing

Before running an agent, you can verify the environment:

```typescript
const adapter = orchestrator.registry.get("claude_local");
const result = await adapter.testEnvironment({
  adapterConfig: { model: "sonnet" },
  cwd: "/workspace",
});

if (result.status !== "pass") {
  console.error("Environment checks failed:", result.checks);
}
```
