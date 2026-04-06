# Types

All core type definitions exported from `agent-orchestrator`.

## Agent

```typescript
interface Agent {
  id: string;
  tenantId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  role?: string;
  status?: string;
  runtimeConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  budgetMonthlyCents?: number;
  createdAt: Date;
  updatedAt: Date;
}
```

## Run

```typescript
interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  invocationSource: InvocationSource;
  triggerDetail: TriggerDetail | null;
  status: RunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  exitCode: number | null;
  signal: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  errorCode: string | null;
  externalRunId: string | null;
  contextSnapshot: Record<string, unknown> | null;
  // ... log fields, wakeup fields, timestamps
}
```

## RunStatus

```typescript
type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
```

## TaskSession

```typescript
interface TaskSession {
  id: string;
  tenantId: string;
  agentId: string;
  adapterType: string;
  taskKey: string;
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  runCount: number;
  totalRawInputTokens: number;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## RuntimeState

```typescript
interface RuntimeState {
  agentId: string;
  tenantId: string;
  adapterType: string;
  sessionId: string | null;
  stateJson: Record<string, unknown>;
  lastRunId: string | null;
  lastRunStatus: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostCents: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## UsageSummary / UsageDelta

```typescript
interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}
```

## CostEvent

```typescript
interface CostEvent {
  id?: string;
  tenantId: string;
  agentId: string;
  runId: string;
  costCents: number;
  currency: string;
  provider?: string;
  model?: string;
  billingType?: AdapterBillingType;
  createdAt?: Date;
}
```

## WakeupRequest

```typescript
interface WakeupRequest {
  id: string;
  agentId: string;
  tenantId: string;
  status: WakeupRequestStatus;
  source: InvocationSource;
  triggerDetail?: TriggerDetail | null;
  contextSnapshot?: Record<string, unknown> | null;
  runId?: string | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## InvocationSource

```typescript
type InvocationSource =
  | "on_demand"
  | "heartbeat"
  | "webhook"
  | "scheduler"
  | "api"
  | "manual";
```

## ResolvedWorkspace

```typescript
interface ResolvedWorkspace {
  cwd: string;
  source: "task_session" | "agent_home" | "configured" | "project";
  warnings: string[];
}
```
