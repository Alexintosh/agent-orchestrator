# Sessions

Session management is how agents maintain context across multiple runs. Instead of starting fresh every time, an agent can resume a previous conversation.

## How Sessions Work

Sessions are tracked per **(agent, adapter, taskKey)** triple:

```
Agent: "code-reviewer"
Adapter: "claude_local"
Task Key: "issue-42"
→ Session: { sessionId: "abc", step: 3, history: [...] }
```

When the same agent is invoked for the same task, the orchestrator loads the previous session and passes it to the adapter, which resumes the conversation.

## Task Keys

The `taskKey` determines session grouping. Different task keys = different sessions.

```typescript
// These share a session (same taskKey)
await orchestrator.invoke(agentId, { taskKey: "issue-42", ... });
await orchestrator.invoke(agentId, { taskKey: "issue-42", ... });

// This gets a fresh session (different taskKey)
await orchestrator.invoke(agentId, { taskKey: "issue-99", ... });
```

If no taskKey is provided, the orchestrator derives one from the invocation context (e.g., `issueId`, `taskId`).

## Session Compaction

Over time, sessions accumulate context and become expensive (high token counts). The orchestrator supports automatic session rotation via compaction policies:

```typescript
await orchestrator.registerAgent({
  name: "long-running-agent",
  tenantId: "co",
  adapterType: "claude_local",
  adapterConfig: { model: "sonnet" },
  runtimeConfig: {
    sessionCompaction: {
      maxSessionRuns: 200,          // Rotate after 200 runs
      maxRawInputTokens: 2_000_000, // Rotate after 2M input tokens
      maxSessionAgeHours: 72,       // Rotate after 72 hours
    },
  },
});
```

When rotation triggers, the orchestrator:
1. Marks the old session for reset
2. Generates a handoff summary (injected into the next prompt)
3. Starts a fresh session with the handoff context

## Session Codec

Each adapter defines how session state is serialized/deserialized:

```typescript
interface AdapterSessionCodec {
  /** Parse stored session params into adapter-native format */
  deserialize(raw: unknown): Record<string, unknown> | null;

  /** Serialize adapter session state for storage */
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;

  /** Extract a human-readable display ID */
  getDisplayId?(params: Record<string, unknown> | null): string | null;
}
```

For Claude, this includes `sessionId`, `cwd`, `workspaceId`, and `repoUrl`. For simpler adapters like Pi, it may just be `sessionId` and `cwd`.

## Inspecting Sessions

```typescript
const session = await orchestrator.store.getTaskSession(
  "company-id",
  "agent-id",
  "claude_local",
  "issue-42",
);

console.log(session?.runCount);          // Number of runs in this session
console.log(session?.sessionParamsJson); // Raw session state
console.log(session?.sessionDisplayId);  // Human-readable ID
```

## Clearing Sessions

Force a fresh start:

```typescript
await orchestrator.store.clearTaskSession("agent-id", "issue-42");
```
