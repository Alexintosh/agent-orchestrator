// ---------------------------------------------------------------------------
// Pi Local Adapter — self-contained port from Paperclip's pi-local adapter.
// All functionality (execute, testEnvironment, sessionCodec, models, output parsing)
// is included inline.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterModel,
  AdapterSessionCodec,
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
  ensureSkillSymlink,
  ensurePathInEnv,
  listSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  runChildProcess,
} from "../_shared/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const ORCHESTRATOR_SESSIONS_DIR = path.join(os.homedir(), ".pi", "orchestrator");

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

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Pi JSONL output parsing (inlined from parse.ts)
// ---------------------------------------------------------------------------

interface ParsedPiOutput {
  sessionId: string | null;
  messages: string[];
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
  };
  finalMessage: string | null;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: string | null;
    isError: boolean;
  }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

function parsePiJsonl(stdout: string): ParsedPiOutput {
  const result: ParsedPiOutput = {
    sessionId: null,
    messages: [],
    errors: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    },
    finalMessage: null,
    toolCalls: [],
  };

  let currentToolCall: { toolCallId: string; toolName: string; args: unknown } | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const eventType = asString(event.type, "");

    // RPC protocol messages - skip these (internal implementation detail)
    if (
      eventType === "response" ||
      eventType === "extension_ui_request" ||
      eventType === "extension_ui_response" ||
      eventType === "extension_error"
    ) {
      continue;
    }

    // Agent lifecycle
    if (eventType === "agent_start") {
      continue;
    }

    if (eventType === "agent_end") {
      const messages = event.messages as Array<Record<string, unknown>> | undefined;
      if (messages && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "assistant") {
          const content = lastMessage.content as string | Array<{ type: string; text?: string }>;
          result.finalMessage = extractTextContent(content);
        }
      }
      continue;
    }

    // Turn lifecycle
    if (eventType === "turn_start") {
      continue;
    }

    if (eventType === "turn_end") {
      const message = asRecord(event.message);
      if (message) {
        const content = message.content as string | Array<{ type: string; text?: string }>;
        const text = extractTextContent(content);
        if (text) {
          result.finalMessage = text;
          result.messages.push(text);
        }

        // Extract usage and cost from assistant message
        const usage = asRecord(message.usage);
        if (usage) {
          result.usage.inputTokens += asNumber(usage.input, 0);
          result.usage.outputTokens += asNumber(usage.output, 0);
          result.usage.cachedInputTokens += asNumber(usage.cacheRead, 0);

          // Pi stores cost in usage.cost.total (and broken down in usage.cost.input, etc.)
          const cost = asRecord(usage.cost);
          if (cost) {
            result.usage.costUsd += asNumber(cost.total, 0);
          }
        }
      }

      // Tool results are in toolResults array
      const toolResults = event.toolResults as Array<Record<string, unknown>> | undefined;
      if (toolResults) {
        for (const tr of toolResults) {
          const toolCallId = asString(tr.toolCallId, "");
          const content = tr.content;
          const isError = tr.isError === true;

          // Find matching tool call by toolCallId
          const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
          if (existingCall) {
            existingCall.result = typeof content === "string" ? content : JSON.stringify(content);
            existingCall.isError = isError;
          }
        }
      }
      continue;
    }

    // Message updates (streaming)
    if (eventType === "message_update") {
      const assistantEvent = asRecord(event.assistantMessageEvent);
      if (assistantEvent) {
        const msgType = asString(assistantEvent.type, "");
        if (msgType === "text_delta") {
          const delta = asString(assistantEvent.delta, "");
          if (delta) {
            // Append to last message or create new
            if (result.messages.length === 0) {
              result.messages.push(delta);
            } else {
              result.messages[result.messages.length - 1] += delta;
            }
          }
        }
      }
      continue;
    }

    // Tool execution
    if (eventType === "tool_execution_start") {
      const toolCallId = asString(event.toolCallId, "");
      const toolName = asString(event.toolName, "");
      const args = event.args;
      currentToolCall = { toolCallId, toolName, args };
      result.toolCalls.push({
        toolCallId,
        toolName,
        args,
        result: null,
        isError: false,
      });
      continue;
    }

    if (eventType === "tool_execution_end") {
      const toolCallId = asString(event.toolCallId, "");
      const toolResult = event.result;
      const isError = event.isError === true;

      // Find the tool call by toolCallId (not toolName, to handle multiple calls to same tool)
      const existingCall = result.toolCalls.find((tc) => tc.toolCallId === toolCallId);
      if (existingCall) {
        existingCall.result = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
        existingCall.isError = isError;
      }
      currentToolCall = null;
      continue;
    }

    // Usage tracking if available in the event (fallback for standalone usage events)
    if (eventType === "usage" || event.usage) {
      const usage = asRecord(event.usage);
      if (usage) {
        // Support both Pi format (input/output/cacheRead) and generic format (inputTokens/outputTokens/cachedInputTokens)
        result.usage.inputTokens += asNumber(usage.inputTokens ?? usage.input, 0);
        result.usage.outputTokens += asNumber(usage.outputTokens ?? usage.output, 0);
        result.usage.cachedInputTokens += asNumber(usage.cachedInputTokens ?? usage.cacheRead, 0);

        // Cost may be in usage.costUsd (direct) or usage.cost.total (Pi format)
        const cost = asRecord(usage.cost);
        if (cost) {
          result.usage.costUsd += asNumber(cost.total ?? usage.costUsd, 0);
        } else {
          result.usage.costUsd += asNumber(usage.costUsd, 0);
        }
      }
    }
  }

  return result;
}

function isPiUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+session/i.test(haystack);
}

// ---------------------------------------------------------------------------
// Model discovery (inlined from models.ts)
// ---------------------------------------------------------------------------

const MODELS_CACHE_TTL_MS = 60_000;

function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const lines = stdout.split(/\r?\n/);

  // Skip header line if present
  let startIndex = 0;
  if (lines.length > 0 && (lines[0].includes("provider") || lines[0].includes("model"))) {
    startIndex = 1;
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse format: "provider   model   context  max-out  thinking  images"
    // Split by 2+ spaces to handle the columnar format
    const parts = line.split(/\s{2,}/);
    if (parts.length < 2) continue;

    const provider = parts[0].trim();
    const model = parts[1].trim();

    if (!provider || !model) continue;
    if (provider === "provider" && model === "model") continue; // Skip header

    const id = `${provider}/${model}`;
    parsed.push({ id, label: id });
  }

  return parsed;
}

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

function resolvePiCommand(input: unknown): string {
  const envOverride =
    typeof process.env.ORCHESTRATOR_PI_COMMAND === "string" &&
    process.env.ORCHESTRATOR_PI_COMMAND.trim().length > 0
      ? process.env.ORCHESTRATOR_PI_COMMAND.trim()
      : "pi";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["ORCHESTRATOR_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
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

async function discoverPiModels(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  const result = await runChildProcess(
    `pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--list-models"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error("`pi --list-models` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`pi --list-models\` failed: ${detail}` : "`pi --list-models` failed.");
  }

  return sortModels(dedupeModels(parseModelsOutput(result.stdout)));
}

async function discoverPiModelsCached(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolvePiCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverPiModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

async function ensurePiModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("Pi requires `adapterConfig.model` in provider/model format.");
  }

  const models = await discoverPiModelsCached({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
  });

  if (models.length === 0) {
    throw new Error("Pi returned no models. Run `pi --list-models` and verify provider auth.");
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models
      .slice(0, 12)
      .map((entry) => entry.id)
      .join(", ");
    throw new Error(
      `Configured Pi model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

async function listPiModels(): Promise<AdapterModel[]> {
  try {
    return await discoverPiModelsCached();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Skills injection
// ---------------------------------------------------------------------------

async function ensurePiSkillsInjected(onLog: AdapterExecutionContext["onLog"]) {
  const skillsEntries = await listSkillEntries(__moduleDir);
  if (skillsEntries.length === 0) return;

  const piSkillsHome = path.join(os.homedir(), ".pi", "agent", "skills");
  await fs.mkdir(piSkillsHome, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    piSkillsHome,
    skillsEntries.map((entry) => entry.name),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[orchestrator] Removed maintainer-only Pi skill "${skillName}" from ${piSkillsHome}\n`,
    );
  }

  for (const entry of skillsEntries) {
    const target = path.join(piSkillsHome, entry.name);

    try {
      const result = await ensureSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[orchestrator] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.name}" into ${piSkillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[orchestrator] Failed to inject Pi skill "${entry.name}" into ${piSkillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function ensureSessionsDir(): Promise<string> {
  await fs.mkdir(ORCHESTRATOR_SESSIONS_DIR, { recursive: true });
  return ORCHESTRATOR_SESSIONS_DIR;
}

function buildSessionPath(agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(ORCHESTRATOR_SESSIONS_DIR, `${safeTimestamp}-${agentId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your work.",
  );
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

  const workspaceContext = parseObject(context.orchestratorWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.orchestratorWorkspaces)
    ? context.orchestratorWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // Ensure sessions directory exists
  await ensureSessionsDir();

  // Inject skills
  await ensurePiSkillsInjected(onLog);

  // Build environment
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.ORCHESTRATOR_API_KEY === "string" && envConfig.ORCHESTRATOR_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildAgentEnv(agent) };
  env.ORCHESTRATOR_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
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
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) env.ORCHESTRATOR_TASK_ID = wakeTaskId;
  if (wakeReason) env.ORCHESTRATOR_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.ORCHESTRATOR_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.ORCHESTRATOR_APPROVAL_ID = approvalId;
  if (approvalStatus) env.ORCHESTRATOR_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.ORCHESTRATOR_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (workspaceCwd) env.ORCHESTRATOR_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) env.ORCHESTRATOR_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.ORCHESTRATOR_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.ORCHESTRATOR_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.ORCHESTRATOR_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.ORCHESTRATOR_WORKSPACES_JSON = JSON.stringify(workspaceHints);

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

  // Validate model is available before execution
  await ensurePiModelConfiguredAndAvailable({
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

  // Handle session
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionPath = canResumeSession
    ? runtimeSessionId
    : buildSessionPath(agent.id, new Date().toISOString());

  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[orchestrator] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // Ensure session file exists (Pi requires this on first run)
  if (!canResumeSession) {
    try {
      await fs.writeFile(sessionPath, "", { flag: "wx" });
    } catch (err) {
      // File may already exist, that's ok
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }

  // Handle instructions file and build system prompt extension
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";

  let systemPromptExtension = "";
  let instructionsReadFailed = false;
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      systemPromptExtension =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
        `You are agent {{agent.id}} ({{agent.name}}). Continue your work.`;
      await onLog(
        "stderr",
        `[orchestrator] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`,
      );
    } catch (err) {
      instructionsReadFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[orchestrator] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
      // Fall back to base prompt template
      systemPromptExtension = promptTemplate;
    }
  } else {
    systemPromptExtension = promptTemplate;
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    tenantId: agent.tenantId,
    runId,
    company: { id: agent.tenantId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
  const renderedHeartbeatPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !canResumeSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.orchestratorSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedHeartbeatPrompt,
  ]);
  const promptMetrics = {
    systemPromptChars: renderedSystemPromptExtension.length,
    promptChars: userPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedHeartbeatPrompt.length,
  };

  const commandNotes = (() => {
    if (!resolvedInstructionsFilePath) return [] as string[];
    if (instructionsReadFailed) {
      return [
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ];
    }
    return [
      `Loaded agent instructions from ${resolvedInstructionsFilePath}`,
      `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
    ];
  })();

  const buildArgs = (sessionFile: string): string[] => {
    const args: string[] = [];

    // Use RPC mode for proper lifecycle management (waits for agent completion)
    args.push("--mode", "rpc");

    // Use --append-system-prompt to extend Pi's default system prompt
    args.push("--append-system-prompt", renderedSystemPromptExtension);

    if (provider) args.push("--provider", provider);
    if (modelId) args.push("--model", modelId);
    if (thinking) args.push("--thinking", thinking);

    args.push("--tools", "read,bash,edit,write,grep,find,ls");
    args.push("--session", sessionFile);

    if (extraArgs.length > 0) args.push(...extraArgs);

    return args;
  };

  const buildRpcStdin = (): string => {
    // Send the prompt as an RPC command
    const promptCommand = {
      type: "prompt",
      message: userPrompt,
    };
    return JSON.stringify(promptCommand) + "\n";
  };

  const runAttempt = async (sessionFile: string) => {
    const args = buildArgs(sessionFile);
    if (onMeta) {
      await onMeta({
        adapterType: "pi_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt: userPrompt,
        promptMetrics,
        context,
      });
    }

    // Buffer stdout by lines to handle partial JSON chunks
    let stdoutBuffer = "";
    const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stderr") {
        // Pass stderr through immediately (not JSONL)
        await onLog(stream, chunk);
        return;
      }

      // Buffer stdout and emit only complete lines
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      stdoutBuffer = lines.pop() || "";

      // Emit complete lines
      for (const line of lines) {
        if (line) {
          await onLog(stream, line + "\n");
        }
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog: bufferedOnLog,
      stdin: buildRpcStdin(),
    });

    // Flush any remaining buffer content
    if (stdoutBuffer) {
      await onLog("stdout", stdoutBuffer);
    }

    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parsePiJsonl(proc.stdout),
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
      parsed: ReturnType<typeof parsePiJsonl>;
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

    const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
    const resolvedSessionParams = resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null;

    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const fallbackErrorMessage = stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

    return {
      exitCode: rawExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (rawExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: provider,
      model: model,
      billingType: "unknown",
      costUsd: attempt.parsed.usage.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
      clearSession: Boolean(clearSessionOnMissingSession),
    };
  };

  const initial = await runAttempt(sessionPath);
  const initialFailed =
    !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);

  if (
    canResumeSession &&
    initialFailed &&
    isPiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stderr",
      `[orchestrator] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const newSessionPath = buildSessionPath(agent.id, new Date().toISOString());
    try {
      await fs.writeFile(newSessionPath, "", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const retry = await runAttempt(newSessionPath);
    return toResult(retry, true);
  }

  return toResult(initial);
}

// ---------------------------------------------------------------------------
// testEnvironment
// ---------------------------------------------------------------------------

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function summarizeProbeDetail(
  stdout: string,
  stderr: string,
  parsedError: string | null,
): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

const PI_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|free\s+usage\s+exceeded)/i;

async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "pi");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "pi_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "pi_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

  const cwdInvalid = checks.some((check) => check.code === "pi_cwd_invalid");
  if (cwdInvalid) {
    checks.push({
      code: "pi_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
      checks.push({
        code: "pi_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "pi_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "pi_cwd_invalid" && check.code !== "pi_command_unresolvable",
  );

  if (canRunProbe) {
    try {
      const discovered = await discoverPiModelsCached({ command, cwd, env: runtimeEnv });
      if (discovered.length > 0) {
        checks.push({
          code: "pi_models_discovered",
          level: "info",
          message: `Discovered ${discovered.length} model(s) from Pi.`,
        });
      } else {
        checks.push({
          code: "pi_models_empty",
          level: "warn",
          message: "Pi returned no models.",
          hint: "Run `pi --list-models` and verify provider authentication.",
        });
      }
    } catch (err) {
      checks.push({
        code: "pi_models_discovery_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Pi model discovery failed.",
        hint: "Run `pi --list-models` manually to verify provider auth and config.",
      });
    }
  }

  const configuredModel = asString(config.model, "").trim();
  if (!configuredModel) {
    checks.push({
      code: "pi_model_required",
      level: "error",
      message: "Pi requires a configured model in provider/model format.",
      hint: "Set adapterConfig.model using an ID from `pi --list-models`.",
    });
  } else if (canRunProbe) {
    // Verify model is in the list
    try {
      const discovered = await discoverPiModelsCached({ command, cwd, env: runtimeEnv });
      const modelExists = discovered.some((m: { id: string }) => m.id === configuredModel);
      if (modelExists) {
        checks.push({
          code: "pi_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
      } else {
        checks.push({
          code: "pi_model_not_found",
          level: "warn",
          message: `Configured model "${configuredModel}" not found in available models.`,
          hint: "Run `pi --list-models` and choose a currently available provider/model ID.",
        });
      }
    } catch {
      // If we can't verify, just note it
      checks.push({
        code: "pi_model_configured",
        level: "info",
        message: `Configured model: ${configuredModel}`,
      });
    }
  }

  if (canRunProbe && configuredModel) {
    // Parse model for probe
    const probeProvider = configuredModel.includes("/")
      ? configuredModel.slice(0, configuredModel.indexOf("/"))
      : "";
    const probeModelId = configuredModel.includes("/")
      ? configuredModel.slice(configuredModel.indexOf("/") + 1)
      : configuredModel;
    const probeThinking = asString(config.thinking, "").trim();
    const probeExtraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

    const args = ["-p", "Respond with hello.", "--mode", "json"];
    if (probeProvider) args.push("--provider", probeProvider);
    if (probeModelId) args.push("--model", probeModelId);
    if (probeThinking) args.push("--thinking", probeThinking);
    args.push("--tools", "read");
    if (probeExtraArgs.length > 0) args.push(...probeExtraArgs);

    try {
      const probe = await runChildProcess(
        `pi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsed = parsePiJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errors[0] ?? null);
      const authEvidence = `${parsed.errors.join("\n")}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "pi_hello_probe_timed_out",
          level: "warn",
          message: "Pi hello probe timed out.",
          hint: "Retry the probe. If this persists, run Pi manually in this working directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && parsed.errors.length === 0) {
        const summary = (parsed.finalMessage || parsed.messages.join(" ")).trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "pi_hello_probe_passed" : "pi_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Pi hello probe succeeded."
            : "Pi probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Run `pi --mode json` manually and prompt `Respond with hello` to inspect output.",
              }),
        });
      } else if (PI_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "pi_hello_probe_auth_required",
          level: "warn",
          message: "Pi is installed, but provider authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Set provider API key environment variable (e.g., ANTHROPIC_API_KEY, XAI_API_KEY) and retry.",
        });
      } else {
        checks.push({
          code: "pi_hello_probe_failed",
          level: "error",
          message: "Pi hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `pi --mode json` manually in this working directory to debug.",
        });
      }
    } catch (err) {
      checks.push({
        code: "pi_hello_probe_failed",
        level: "error",
        message: "Pi hello probe failed.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Run `pi --mode json` manually in this working directory to debug.",
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
// Session codec
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};

// ---------------------------------------------------------------------------
// Agent configuration documentation
// ---------------------------------------------------------------------------

const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): path to a markdown instructions file injected at runtime (resolved relative to cwd)
- model (string, required): Pi model id in provider/model format (e.g., "anthropic/claude-sonnet-4-5-20250929")
- thinking (string, optional): reasoning mode passed via --thinking
- promptTemplate (string, optional): run prompt template
- bootstrapPromptTemplate (string, optional): prompt used only on fresh sessions (not resumes)
- command (string, optional): defaults to "pi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi uses RPC mode (--mode rpc) for proper lifecycle management.
- Sessions are stored as JSONL files under ~/.pi/orchestrator/.
- Model discovery uses \`pi --list-models\` and is cached for 60 seconds.
- When the orchestrator realizes a workspace/runtime for a run, it injects ORCHESTRATOR_WORKSPACE_* env vars for agent-side tooling.
`;

// ---------------------------------------------------------------------------
// Exported adapter module
// ---------------------------------------------------------------------------

export const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute,
  testEnvironment,
  sessionCodec,
  supportsDirectLlmSessions: false,
  supportsLocalAgentJwt: false,
  listModels: listPiModels,
  agentConfigurationDoc,
};

export default piLocalAdapter;
