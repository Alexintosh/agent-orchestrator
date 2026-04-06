// ---------------------------------------------------------------------------
// agent-orchestrator — Standalone agent orchestration library
//
// Schedule, execute, and manage sessions for CLI-based AI agents
// (Claude, Codex, Gemini, Cursor, OpenCode, Pi, OpenClaw).
// ---------------------------------------------------------------------------

// --- Core Types ---
export type {
  Agent,
  AdapterAgent,
  AdapterRuntime,
  TaskSession,
  RuntimeState,
  UsageSummary,
  UsageDelta,
  AdapterBillingType,
  CostEvent,
  AdapterRuntimeServiceReport,
  AdapterExecutionResult,
  AdapterSessionCodec,
  AdapterInvocationMeta,
  AdapterExecutionContext,
  AdapterModel,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestStatus,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestContext,
  ServerAdapterModule,
  InvocationSource,
  TriggerDetail,
  RunStatus,
  WakeupRequestStatus,
  Run,
  NewRun,
  WakeupRequest,
  ResolvedWorkspace,
  SessionCompactionPolicy,
  TranscriptEntry,
  StdoutLineParser,
} from "./types.js";

export { DEFAULT_TENANT_ID } from "./types.js";

// --- Interfaces ---
export type {
  OrchestratorStore,
  WorkspaceResolver,
  RunContext,
  AuthProvider,
  TokenClaims,
  RunLogger,
  RunLogHandle,
  RunLogReadOptions,
  RunLogReadResult,
  RunLogFinalizeSummary,
  Logger,
  OrchestratorEventEmitter,
  OrchestratorEventMap,
  OrchestratorEventName,
} from "./interfaces/index.js";

// --- Default Implementations ---
export { DefaultAuth, NoAuth, type DefaultAuthOptions } from "./auth.js";
export { DefaultRunLogger, NullRunLogger } from "./run-log.js";
export { SimpleWorkspaceResolver } from "./workspace.js";
export { EventEmitter } from "./events.js";
export { MemoryStore } from "./stores/memory.js";

// --- Core Modules ---
export { AdapterRegistry } from "./adapters/registry.js";
export { executeRun, type ExecutorDeps } from "./executor.js";
export { createScheduler, type SchedulerDeps, type WakeupOptions } from "./scheduler.js";

// --- Session Utilities ---
export {
  defaultSessionCodec,
  parseSessionCompactionPolicy,
  shouldResetTaskSessionForWake,
  deriveTaskKey,
  resolveNextSessionState,
  normalizeUsageTotals,
  enrichWakeContextSnapshot,
} from "./session.js";

// --- Shared Adapter Utilities ---
export {
  runChildProcess,
  runningProcesses,
  type RunProcessResult,
  buildAgentEnv,
  ensurePathInEnv,
  defaultPathForPlatform,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  renderTemplate,
  resolvePathValue,
  joinPromptSections,
  redactEnvForLogs,
  resolveSkillsDir,
  listSkillEntries,
  readSkillMarkdown,
  ensureSkillSymlink,
  removeMaintainerOnlySkillSymlinks,
  type SkillEntry,
  parseObject,
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseJson,
  appendWithCap,
  MAX_CAPTURE_BYTES,
  MAX_EXCERPT_BYTES,
} from "./adapters/_shared/index.js";

// --- Bundled Adapters ---
export { claudeLocalAdapter } from "./adapters/claude-local/index.js";
export { codexLocalAdapter } from "./adapters/codex-local/index.js";
export { cursorLocalAdapter } from "./adapters/cursor-local/index.js";
export { geminiLocalAdapter } from "./adapters/gemini-local/index.js";
export { opencodeLocalAdapter } from "./adapters/opencode-local/index.js";
export { piLocalAdapter } from "./adapters/pi-local/index.js";
export { openclawGatewayAdapter } from "./adapters/openclaw-gateway/index.js";

/** Convenience object with all bundled adapters. */
export { adapters } from "./adapters/all.js";

// ---------------------------------------------------------------------------
// createOrchestrator — Factory function for a fully wired orchestrator
// ---------------------------------------------------------------------------

import type { OrchestratorStore } from "./interfaces/store.js";
import type { WorkspaceResolver } from "./interfaces/workspace.js";
import type { AuthProvider } from "./interfaces/auth.js";
import type { RunLogger, Logger } from "./interfaces/logger.js";
import type { ServerAdapterModule, Run, Agent, AdapterModel } from "./types.js";
import { DEFAULT_TENANT_ID } from "./types.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { EventEmitter } from "./events.js";
import { executeRun as execRun } from "./executor.js";
import { createScheduler } from "./scheduler.js";
import { DefaultAuth, NoAuth } from "./auth.js";
import { NullRunLogger } from "./run-log.js";
import { SimpleWorkspaceResolver } from "./workspace.js";
import { MemoryStore } from "./stores/memory.js";

export interface OrchestratorOptions {
  /** Storage backend (required). Use MemoryStore for testing. */
  store?: OrchestratorStore;

  /** Registered adapter modules. */
  adapters?: ServerAdapterModule[];

  /** Workspace resolution strategy. */
  workspace?:
    | WorkspaceResolver
    | { defaultCwd: string; agentWorkspaceBase?: string };

  /** Authentication provider for agent JWT tokens. */
  auth?: AuthProvider | { secret: string; ttlSeconds?: number };

  /** Run log storage. */
  runLogger?: RunLogger;

  /** Structured logger. */
  logger?: Logger;
}

const consoleLogger: Logger = {
  info: (...args: unknown[]) =>
    console.log("[orchestrator]", ...args),
  warn: (...args: unknown[]) =>
    console.warn("[orchestrator]", ...args),
  error: (...args: unknown[]) =>
    console.error("[orchestrator]", ...args),
  debug: (...args: unknown[]) =>
    console.debug("[orchestrator]", ...args),
};

export interface Orchestrator {
  /** Execute a run by ID. */
  executeRun(runId: string): Promise<import("./types.js").AdapterExecutionResult | null>;

  /** Invoke an agent — queue a run and start it. */
  invoke(
    agentId: string,
    opts?: import("./scheduler.js").WakeupOptions,
  ): Promise<Run | null>;

  /** Register a new agent. tenantId defaults to "default" if omitted. */
  registerAgent(
    agent: Omit<Agent, "id" | "tenantId" | "createdAt" | "updatedAt"> & { id?: string; tenantId?: string },
  ): Promise<Agent>;

  /** Cancel a run. */
  cancelRun(runId: string): Promise<boolean>;

  /** Start the scheduler timer. */
  start(intervalMs?: number): void;

  /** Stop the scheduler timer. */
  stop(): void;

  /** Tick timers manually. */
  tickTimers(): Promise<void>;

  /** List models across all adapters. */
  listModels(): Promise<Array<{ adapterType: string; models: AdapterModel[] }>>;

  /** Subscribe to events. */
  on: EventEmitter["on"];

  /** Unsubscribe from events. */
  off: EventEmitter["off"];

  /** The underlying store. */
  readonly store: OrchestratorStore;

  /** The adapter registry. */
  readonly registry: AdapterRegistry;

  /** The event emitter. */
  readonly events: EventEmitter;
}

/**
 * Create a fully-wired orchestrator instance.
 *
 * @example
 * ```typescript
 * import { createOrchestrator, MemoryStore } from 'agent-orchestrator';
 *
 * const orchestrator = createOrchestrator({
 *   store: new MemoryStore(),
 *   adapters: [myClaudeAdapter],
 *   workspace: { defaultCwd: '/workspace' },
 * });
 *
 * const agent = await orchestrator.registerAgent({
 *   name: 'my-agent',
 *   tenantId: 'company-1',
 *   adapterType: 'claude_local',
 *   adapterConfig: { model: 'opus' },
 * });
 *
 * const run = await orchestrator.invoke(agent.id);
 * ```
 */
export function createOrchestrator(opts: OrchestratorOptions = {}): Orchestrator {
  const store = opts.store ?? new MemoryStore();
  const registry = new AdapterRegistry(opts.adapters);
  const events = new EventEmitter();
  const logger = opts.logger ?? consoleLogger;
  const runLogger = opts.runLogger ?? new NullRunLogger();

  // Resolve workspace
  let workspaceResolver: WorkspaceResolver;
  if (opts.workspace && "resolve" in opts.workspace) {
    workspaceResolver = opts.workspace;
  } else if (opts.workspace && "defaultCwd" in opts.workspace) {
    workspaceResolver = new SimpleWorkspaceResolver(opts.workspace);
  } else {
    workspaceResolver = new SimpleWorkspaceResolver({
      defaultCwd: process.cwd(),
    });
  }

  // Resolve auth
  let authProvider: AuthProvider;
  if (opts.auth && "createToken" in opts.auth) {
    authProvider = opts.auth;
  } else if (opts.auth && "secret" in opts.auth) {
    authProvider = new DefaultAuth(opts.auth);
  } else {
    authProvider = new NoAuth();
  }

  const executorDeps = {
    store,
    getAdapter: (type: string) => registry.get(type),
    workspace: workspaceResolver,
    auth: authProvider,
    runLogger,
    logger,
    events,
  };

  const scheduler = createScheduler({
    store,
    events,
    logger,
    executeRun: (runId) => execRun(runId, executorDeps).then(() => undefined),
  });

  return {
    async executeRun(runId: string) {
      return execRun(runId, executorDeps);
    },

    async invoke(agentId, invokeOpts) {
      return scheduler.invoke(agentId, invokeOpts);
    },

    async registerAgent(agent) {
      return store.createAgent({
        id: agent.id ?? "",
        tenantId: agent.tenantId ?? DEFAULT_TENANT_ID,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
        role: agent.role,
        status: agent.status ?? "active",
        runtimeConfig: agent.runtimeConfig,
        metadata: agent.metadata,
        budgetMonthlyCents: agent.budgetMonthlyCents,
      });
    },

    async cancelRun(runId) {
      return scheduler.cancelRun(runId);
    },

    start(intervalMs) {
      scheduler.start(intervalMs);
    },

    stop() {
      scheduler.stop();
    },

    async tickTimers() {
      await scheduler.tickTimers();
    },

    async listModels() {
      return registry.listAllModels();
    },

    on: events.on.bind(events),
    off: events.off.bind(events),

    store,
    registry,
    events,
  };
}
