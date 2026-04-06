// ---------------------------------------------------------------------------
// OpenCode Local Adapter — self-contained port from Paperclip's opencode-local adapter.
// All functionality (execute, testEnvironment, sessionCodec, models, output parsing)
// is included inline.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterSessionCodec,
  AdapterModel,
  ServerAdapterModule,
} from "../../types.js";

import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  parseJson,
  buildAgentEnv,
  joinPromptSections,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
  resolveSkillsDir,
} from "../_shared/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 20_000;

const OPENCODE_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|opencode\s+auth\s+login|free\s+usage\s+exceeded)/i;

const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "ORCHESTRATOR_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

// ---------------------------------------------------------------------------
// Skills injection
// ---------------------------------------------------------------------------

function claudeSkillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
) {
  const skillsDir = await resolveSkillsDir(__moduleDir);
  if (!skillsDir) return;

  const skillsHome = claudeSkillsHome();
  await fs.mkdir(skillsHome, { recursive: true });
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(skillsDir, entry.name);
    const target = path.join(skillsHome, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) continue;

    try {
      await fs.symlink(source, target);
      await onLog(
        "stderr",
        `[orchestrator] Injected OpenCode skill "${entry.name}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[orchestrator] Failed to inject OpenCode skill "${entry.name}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

// ---------------------------------------------------------------------------
// Output parsing (inlined from parse.ts)
// ---------------------------------------------------------------------------

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens +=
        asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) errors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}

function isOpenCodeUnknownSessionError(
  stdout: string,
  stderr: string,
): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}

// ---------------------------------------------------------------------------
// Model discovery & cache (inlined from models.ts)
// ---------------------------------------------------------------------------

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.ORCHESTRATOR_OPENCODE_COMMAND === "string" &&
    process.env.ORCHESTRATOR_OPENCODE_COMMAND.trim().length > 0
      ? process.env.ORCHESTRATOR_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<
  string,
  { expiresAt: number; models: AdapterModel[] }
>();

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    parsed.push({
      id: `${provider}/${model}`,
      label: `${provider}/${model}`,
    });
  }
  return dedupeModels(parsed);
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(
  command: string,
  cwd: string,
  env: Record<string, string>,
) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

async function discoverOpenCodeModels(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv(
    ensurePathInEnv({ ...process.env, ...env }),
  );

  const result = await runChildProcess(
    `opencode-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: MODELS_DISCOVERY_TIMEOUT_MS / 1000,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(
      `\`opencode models\` timed out after ${MODELS_DISCOVERY_TIMEOUT_MS / 1000}s.`,
    );
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail =
      firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(
      detail
        ? `\`opencode models\` failed: ${detail}`
        : "`opencode models` failed.",
    );
  }

  return sortModels(parseModelsOutput(result.stdout));
}

async function discoverOpenCodeModelsCached(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, cwd, env });
  discoveryCache.set(key, {
    expiresAt: now + MODELS_CACHE_TTL_MS,
    models,
  });
  return models;
}

async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error(
      "OpenCode requires `adapterConfig.model` in provider/model format.",
    );
  }

  const models = await discoverOpenCodeModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (models.length === 0) {
    throw new Error(
      "OpenCode returned no models. Run `opencode models` and verify provider auth.",
    );
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models
      .slice(0, 12)
      .map((entry) => entry.id)
      .join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

async function listOpenCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Session codec (inlined from server/index.ts)
// ---------------------------------------------------------------------------

const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId =
      readNonEmptyString(record.workspaceId) ??
      readNonEmptyString(record.workspace_id);
    const repoUrl =
      readNonEmptyString(record.repoUrl) ??
      readNonEmptyString(record.repo_url);
    const repoRef =
      readNonEmptyString(record.repoRef) ??
      readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId =
      readNonEmptyString(params.workspaceId) ??
      readNonEmptyString(params.workspace_id);
    const repoUrl =
      readNonEmptyString(params.repoUrl) ??
      readNonEmptyString(params.repo_url);
    const repoRef =
      readNonEmptyString(params.repoRef) ??
      readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};

// ---------------------------------------------------------------------------
// Execute (inlined from execute.ts)
// ---------------------------------------------------------------------------

async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } =
    ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your work.",
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome
    ? ""
    : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  await ensureOpenCodeSkillsInjected(onLog);

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.ORCHESTRATOR_API_KEY === "string" &&
    envConfig.ORCHESTRATOR_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildAgentEnv(agent) };
  env.ORCHESTRATOR_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" &&
      context.taskId.trim().length > 0 &&
      context.taskId.trim()) ||
    (typeof context.issueId === "string" &&
      context.issueId.trim().length > 0 &&
      context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" &&
    context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" &&
      context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" &&
      context.commentId.trim().length > 0 &&
      context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" &&
    context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" &&
    context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];
  if (wakeTaskId) env.ORCHESTRATOR_TASK_ID = wakeTaskId;
  if (wakeReason) env.ORCHESTRATOR_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.ORCHESTRATOR_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.ORCHESTRATOR_APPROVAL_ID = approvalId;
  if (approvalStatus) env.ORCHESTRATOR_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0)
    env.ORCHESTRATOR_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd)
    env.ORCHESTRATOR_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource)
    env.ORCHESTRATOR_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.ORCHESTRATOR_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl)
    env.ORCHESTRATOR_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef)
    env.ORCHESTRATOR_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0)
    env.ORCHESTRATOR_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.ORCHESTRATOR_API_KEY = authToken;
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  await ensureOpenCodeModelConfiguredAndAvailable({
    model,
    command,
    cwd,
    env: runtimeEnv,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(
    runtimeSessionParams.sessionId,
    runtime.sessionId ?? "",
  );
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 ||
      path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[orchestrator] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(
    config.instructionsFilePath,
    "",
  ).trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsDir = resolvedInstructionsFilePath
    ? `${path.dirname(resolvedInstructionsFilePath)}/`
    : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(
        resolvedInstructionsFilePath,
        "utf8",
      );
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      await onLog(
        "stderr",
        `[orchestrator] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[orchestrator] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const commandNotes = (() => {
    if (!resolvedInstructionsFilePath) return [] as string[];
    if (instructionsPrefix.length > 0) {
      return [
        `Loaded agent instructions from ${resolvedInstructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
      ];
    }
    return [
      `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    ];
  })();

  const bootstrapPromptTemplate = asString(
    config.bootstrapPromptTemplate,
    "",
  );
  const templateData = {
    agentId: agent.id,
    tenantId: agent.tenantId,
    runId,
    company: { id: agent.tenantId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(
    context.paperclipSessionHandoffMarkdown,
    "",
  ).trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["run", "--format", "json"];
    if (resumeSessionId) args.push("--session", resumeSessionId);
    if (model) args.push("--model", model);
    if (variant) args.push("--variant", variant);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "opencode_local",
        command,
        cwd,
        commandNotes,
        commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog,
    });
    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parseOpenCodeJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };
      rawStderr: string;
      parsed: ReturnType<typeof parseOpenCodeJsonl>;
    },
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (clearSessionOnMissingSession
        ? null
        : (runtimeSessionId ?? runtime.sessionId ?? null));
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const parsedError =
      typeof attempt.parsed.errorMessage === "string"
        ? attempt.parsed.errorMessage.trim()
        : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const synthesizedExitCode =
      parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
    const modelId = model || null;

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: parseModelProvider(modelId),
      model: modelId,
      billingType: "unknown",
      costUsd: attempt.parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(
        clearSessionOnMissingSession && !attempt.parsed.sessionId,
      ),
    };
  };

  const initial = await runAttempt(sessionId);
  const initialFailed =
    !initial.proc.timedOut &&
    ((initial.proc.exitCode ?? 0) !== 0 ||
      Boolean(initial.parsed.errorMessage));
  if (
    sessionId &&
    initialFailed &&
    isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stderr",
      `[orchestrator] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}

// ---------------------------------------------------------------------------
// Test environment (inlined from test.ts)
// ---------------------------------------------------------------------------

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function summarizeProbeDetail(
  stdout: string,
  stderr: string,
  parsedError: string | null,
): string | null {
  const raw =
    parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "opencode");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "opencode_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "opencode_cwd_invalid",
      level: "error",
      message:
        err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const openaiKeyOverride =
    "OPENAI_API_KEY" in envConfig
      ? asString(envConfig.OPENAI_API_KEY, "")
      : null;
  if (openaiKeyOverride !== null && openaiKeyOverride.trim() === "") {
    checks.push({
      code: "opencode_openai_api_key_missing",
      level: "warn",
      message: "OPENAI_API_KEY override is empty.",
      hint: "The OPENAI_API_KEY override is empty. Set a valid key or remove the override.",
    });
  }

  const runtimeEnv = normalizeEnv(
    ensurePathInEnv({ ...process.env, ...env }),
  );

  const cwdInvalid = checks.some(
    (check) => check.code === "opencode_cwd_invalid",
  );
  if (cwdInvalid) {
    checks.push({
      code: "opencode_command_skipped",
      level: "warn",
      message:
        "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
      checks.push({
        code: "opencode_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "opencode_command_unresolvable",
        level: "error",
        message:
          err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  }

  const canRunProbe = checks.every(
    (check) =>
      check.code !== "opencode_cwd_invalid" &&
      check.code !== "opencode_command_unresolvable",
  );

  let modelValidationPassed = false;
  const configuredModel = asString(config.model, "").trim();

  if (canRunProbe && configuredModel) {
    try {
      const discovered = await discoverOpenCodeModels({
        command,
        cwd,
        env: runtimeEnv,
      });
      if (discovered.length > 0) {
        checks.push({
          code: "opencode_models_discovered",
          level: "info",
          message: `Discovered ${discovered.length} model(s) from OpenCode providers.`,
        });
      } else {
        checks.push({
          code: "opencode_models_empty",
          level: "error",
          message: "OpenCode returned no models.",
          hint: "Run `opencode models` and verify provider authentication.",
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/ProviderModelNotFoundError/i.test(errMsg)) {
        checks.push({
          code: "opencode_hello_probe_model_unavailable",
          level: "warn",
          message: "The configured model was not found by the provider.",
          detail: errMsg,
          hint: "Run `opencode models` and choose an available provider/model ID.",
        });
      } else {
        checks.push({
          code: "opencode_models_discovery_failed",
          level: "error",
          message: errMsg || "OpenCode model discovery failed.",
          hint: "Run `opencode models` manually to verify provider auth and config.",
        });
      }
    }
  } else if (canRunProbe && !configuredModel) {
    try {
      const discovered = await discoverOpenCodeModels({
        command,
        cwd,
        env: runtimeEnv,
      });
      if (discovered.length > 0) {
        checks.push({
          code: "opencode_models_discovered",
          level: "info",
          message: `Discovered ${discovered.length} model(s) from OpenCode providers.`,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/ProviderModelNotFoundError/i.test(errMsg)) {
        checks.push({
          code: "opencode_hello_probe_model_unavailable",
          level: "warn",
          message: "The configured model was not found by the provider.",
          detail: errMsg,
          hint: "Run `opencode models` and choose an available provider/model ID.",
        });
      } else {
        checks.push({
          code: "opencode_models_discovery_failed",
          level: "warn",
          message:
            errMsg ||
            "OpenCode model discovery failed (best-effort, no model configured).",
          hint: "Run `opencode models` manually to verify provider auth and config.",
        });
      }
    }
  }

  const modelUnavailable = checks.some(
    (check) => check.code === "opencode_hello_probe_model_unavailable",
  );
  if (!configuredModel && !modelUnavailable) {
    // No model configured - skip model requirement if no model-related checks exist
  } else if (configuredModel && canRunProbe) {
    try {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model: configuredModel,
        command,
        cwd,
        env: runtimeEnv,
      });
      checks.push({
        code: "opencode_model_configured",
        level: "info",
        message: `Configured model: ${configuredModel}`,
      });
      modelValidationPassed = true;
    } catch (err) {
      checks.push({
        code: "opencode_model_invalid",
        level: "error",
        message:
          err instanceof Error
            ? err.message
            : "Configured model is unavailable.",
        hint: "Run `opencode models` and choose a currently available provider/model ID.",
      });
    }
  }

  if (canRunProbe && modelValidationPassed) {
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    const variant = asString(config.variant, "").trim();
    const probeModel = configuredModel;

    const args = ["run", "--format", "json"];
    args.push("--model", probeModel);
    if (variant) args.push("--variant", variant);
    if (extraArgs.length > 0) args.push(...extraArgs);

    try {
      const probe = await runChildProcess(
        `opencode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 60,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );

      const parsed = parseOpenCodeJsonl(probe.stdout);
      const detail = summarizeProbeDetail(
        probe.stdout,
        probe.stderr,
        parsed.errorMessage,
      );
      const authEvidence =
        `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "opencode_hello_probe_timed_out",
          level: "warn",
          message: "OpenCode hello probe timed out.",
          hint: "Retry the probe. If this persists, run OpenCode manually in this working directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello
            ? "opencode_hello_probe_passed"
            : "opencode_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "OpenCode hello probe succeeded."
            : "OpenCode probe ran but did not return `hello` as expected.",
          ...(summary
            ? {
                detail: summary.replace(/\s+/g, " ").trim().slice(0, 240),
              }
            : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Run `opencode run --format json` manually and prompt `Respond with hello` to inspect output.",
              }),
        });
      } else if (/ProviderModelNotFoundError/i.test(authEvidence)) {
        checks.push({
          code: "opencode_hello_probe_model_unavailable",
          level: "warn",
          message: "The configured model was not found by the provider.",
          ...(detail ? { detail } : {}),
          hint: "Run `opencode models` and choose an available provider/model ID.",
        });
      } else if (OPENCODE_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "opencode_hello_probe_auth_required",
          level: "warn",
          message:
            "OpenCode is installed, but provider authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `opencode auth login` or set provider credentials, then retry the probe.",
        });
      } else {
        checks.push({
          code: "opencode_hello_probe_failed",
          level: "error",
          message: "OpenCode hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `opencode run --format json` manually in this working directory to debug.",
        });
      }
    } catch (err) {
      checks.push({
        code: "opencode_hello_probe_failed",
        level: "error",
        message: "OpenCode hello probe failed.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Run `opencode run --format json` manually in this working directory to debug.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Adapter module export
// ---------------------------------------------------------------------------

export const opencodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute,
  testEnvironment,
  sessionCodec,
  supportsDirectLlmSessions: false,
  supportsLocalAgentJwt: false,
  models: [],
  listModels: listOpenCodeModels,
  agentConfigurationDoc: `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenCode model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific model variant (for example minimal|low|medium|high|max)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \`opencode models\` to list available options in provider/model format.
- An explicit \`model\` value is required for \`opencode_local\` agents.
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
`,
};

export default opencodeLocalAdapter;
