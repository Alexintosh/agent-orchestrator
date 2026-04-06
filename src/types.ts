// ---------------------------------------------------------------------------
// Core types for the agent orchestration library.
// Adapted from Paperclip's adapter-utils and shared packages.
// ---------------------------------------------------------------------------

// --- Agent ---

export const DEFAULT_TENANT_ID = "default";

export interface Agent {
  id: string;
  /** Tenant/org scope. Defaults to "default" for single-tenant use. */
  tenantId: string;
  name: string;
  role?: string;
  status?: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  budgetMonthlyCents?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AdapterAgent {
  id: string;
  tenantId: string;
  name: string;
  adapterType: string | null;
  adapterConfig: unknown;
}

// --- Runtime / Session ---

export interface AdapterRuntime {
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

export interface TaskSession {
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

export interface RuntimeState {
  agentId: string;
  tenantId: string;
  adapterType: string;
  sessionId: string | null;
  sessionDisplayId?: string | null;
  sessionParamsJson?: Record<string, unknown> | null;
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

// --- Usage / Cost ---

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export type AdapterBillingType = "api" | "subscription" | "unknown";

export interface CostEvent {
  id?: string;
  tenantId: string;
  agentId: string;
  runId: string;
  adapterType: string;
  provider: string | null;
  model: string | null;
  billingType: AdapterBillingType | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  costCents: number;
  createdAt?: Date;
}

// --- Adapter Execution ---

export interface AdapterRuntimeServiceReport {
  id?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  issueId?: string | null;
  scopeType?: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId?: string | null;
  serviceName: string;
  status?: "starting" | "running" | "stopped" | "failed";
  lifecycle?: "shared" | "ephemeral";
  reuseKey?: string | null;
  command?: string | null;
  cwd?: string | null;
  port?: number | null;
  url?: string | null;
  providerRef?: string | null;
  ownerAgentId?: string | null;
  stopPolicy?: Record<string, unknown> | null;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  runtimeServices?: AdapterRuntimeServiceReport[];
  summary?: string | null;
  clearSession?: boolean;
  question?: {
    prompt: string;
    choices: Array<{
      key: string;
      label: string;
      description?: string;
    }>;
  } | null;
}

export interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}

export interface AdapterInvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  env?: Record<string, string>;
  prompt?: string;
  promptMetrics?: Record<string, number>;
  context?: Record<string, unknown>;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  authToken?: string;
}

export interface AdapterModel {
  id: string;
  label: string;
}

// --- Environment Testing ---

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export interface AdapterEnvironmentTestContext {
  tenantId: string;
  adapterType: string;
  config: Record<string, unknown>;
  deployment?: {
    mode?: "local_trusted" | "authenticated";
    exposure?: "private" | "public";
    bindHost?: string | null;
    allowedHostnames?: string[];
  };
}

// --- Adapter Module Contract ---

export interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  sessionCodec?: AdapterSessionCodec;
  supportsDirectLlmSessions?: boolean;
  supportsLocalAgentJwt?: boolean;
  models?: AdapterModel[];
  listModels?: () => Promise<AdapterModel[]>;
  agentConfigurationDoc?: string;
}

// --- Run ---

export type InvocationSource = "timer" | "assignment" | "on_demand" | "automation";
export type TriggerDetail = "manual" | "ping" | "callback" | "system";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type WakeupRequestStatus =
  | "queued"
  | "deferred_task_execution"
  | "claimed"
  | "coalesced"
  | "skipped"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  invocationSource: InvocationSource;
  triggerDetail: TriggerDetail | null;
  status: RunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  wakeupRequestId: string | null;
  exitCode: number | null;
  signal: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  logStore: string | null;
  logRef: string | null;
  logBytes: number | null;
  logSha256: string | null;
  logCompressed: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  errorCode: string | null;
  externalRunId: string | null;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewRun {
  tenantId: string;
  agentId: string;
  invocationSource: InvocationSource;
  triggerDetail?: TriggerDetail | null;
  contextSnapshot?: Record<string, unknown> | null;
  wakeupRequestId?: string | null;
}

export interface WakeupRequest {
  id: string;
  tenantId: string;
  agentId: string;
  source: InvocationSource;
  triggerDetail: TriggerDetail | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  status: WakeupRequestStatus;
  coalescedCount: number;
  requestedByActorType: "user" | "agent" | "system" | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
  runId: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- Workspace ---

export interface ResolvedWorkspace {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home" | "configured";
  projectId?: string | null;
  workspaceId?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  warnings: string[];
}

// --- Session Compaction ---

export interface SessionCompactionPolicy {
  enabled: boolean;
  maxSessionRuns: number;
  maxRawInputTokens: number;
  maxSessionAgeHours: number;
}

// --- Transcript (for UI consumers) ---

export type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

export type StdoutLineParser = (line: string, ts: string) => TranscriptEntry[];
