// ---------------------------------------------------------------------------
// Claude Local Adapter — self-contained port from Paperclip's claude-local adapter.
// All functionality (execute, testEnvironment, sessionCodec, models, output parsing)
// is included inline.
// ---------------------------------------------------------------------------

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
  AdapterSessionCodec,
  AdapterModel,
  ServerAdapterModule,
  UsageSummary,
} from "../../types.js";

import type { RunProcessResult } from "../_shared/index.js";
import {
  asString,
  asNumber,
  asBoolean,
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

// ---------------------------------------------------------------------------
// Skills directory builder
// ---------------------------------------------------------------------------

async function buildSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const skillsDir = await resolveSkillsDir(__moduleDir);
  if (!skillsDir) return tmp;
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.symlink(
        path.join(skillsDir, entry.name),
        path.join(target, entry.name),
      );
    }
  }
  return tmp;
}

// ---------------------------------------------------------------------------
// Output parsing (inlined from parse.ts)
// ---------------------------------------------------------------------------

const CLAUDE_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const URL_RE =
  /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype && subtype !== "success") parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

// ---------------------------------------------------------------------------
// Runtime config builder
// ---------------------------------------------------------------------------

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.orchestratorWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.orchestratorWorkspaces)
    ? context.orchestratorWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.orchestratorRuntimeServiceIntents)
    ? context.orchestratorRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.orchestratorRuntimeServices)
    ? context.orchestratorRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.orchestratorRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

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
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
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

  if (wakeTaskId) {
    env.ORCHESTRATOR_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.ORCHESTRATOR_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.ORCHESTRATOR_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.ORCHESTRATOR_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.ORCHESTRATOR_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.ORCHESTRATOR_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (effectiveWorkspaceCwd) {
    env.ORCHESTRATOR_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.ORCHESTRATOR_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.ORCHESTRATOR_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.ORCHESTRATOR_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.ORCHESTRATOR_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.ORCHESTRATOR_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.ORCHESTRATOR_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.ORCHESTRATOR_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.ORCHESTRATOR_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.ORCHESTRATOR_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.ORCHESTRATOR_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.ORCHESTRATOR_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.ORCHESTRATOR_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
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
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const commandNotes = instructionsFilePath
    ? [
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      ]
    : [];

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  const billingType = resolveClaudeBillingType(env);
  const skillsDir = await buildSkillsDir();

  // When instructionsFilePath is configured, create a combined temp file that
  // includes both the file content and the path directive, so we only need
  // --append-system-prompt-file (Claude CLI forbids using both flags together).
  let effectiveInstructionsFilePath = instructionsFilePath;
  if (instructionsFilePath) {
    const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
    const pathDirective = `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
    const combinedPath = path.join(skillsDir, "agent-instructions.md");
    await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
    effectiveInstructionsFilePath = combinedPath;
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[orchestrator] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
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
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.orchestratorSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    args.push("--add-dir", skillsDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildClaudeArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes,
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stderr",
        `[orchestrator] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// testEnvironment
// ---------------------------------------------------------------------------

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "claude_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_cwd_invalid",
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
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configApiKey = env.ANTHROPIC_API_KEY;
  const hostApiKey = process.env.ANTHROPIC_API_KEY;
  if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "claude_anthropic_api_key_overrides_subscription",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set. Claude will use API-key auth instead of subscription credentials.",
      detail: `Detected in ${source}.`,
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  } else {
    checks.push({
      code: "claude_subscription_mode_possible",
      level: "info",
      message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "claude_cwd_invalid" && check.code !== "claude_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const effort = asString(config.effort, "").trim();
      const chrome = asBoolean(config.chrome, false);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
      if (chrome) args.push("--chrome");
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runChildProcess(
        `claude-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );

      const parsedStream = parseClaudeStreamJson(probe.stdout);
      const parsed = parsedStream.resultJson;
      const loginMeta = detectClaudeLoginRequired({
        parsed,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        checks.push({
          code: "claude_hello_probe_auth_required",
          level: "warn",
          message: "Claude CLI is installed, but login is required.",
          ...(detail ? { detail } : {}),
          hint: loginMeta.loginUrl
            ? `Run \`claude login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
            : "Run `claude login` in this environment, then retry the probe.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "claude_hello_probe_passed" : "claude_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Claude hello probe succeeded."
            : "Claude probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`claude --print - --output-format stream-json --verbose`) and prompt `Respond with hello`.",
              }),
        });
      } else {
        checks.push({
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Claude hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `claude --print - --output-format stream-json --verbose` manually in this directory and prompt `Respond with hello` to debug.",
        });
      }
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
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
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
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
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
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const models: AdapterModel[] = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

// ---------------------------------------------------------------------------
// Agent configuration documentation
// ---------------------------------------------------------------------------

const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions to claude
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): workspace runtime service intents; local host-managed services are realized before Claude starts and exposed back via context/env

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When the orchestrator realizes a workspace/runtime for a run, it injects ORCHESTRATOR_WORKSPACE_* and ORCHESTRATOR_RUNTIME_* env vars for agent-side tooling.
`;

// ---------------------------------------------------------------------------
// Exported adapter module
// ---------------------------------------------------------------------------

export const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute,
  testEnvironment,
  sessionCodec,
  supportsDirectLlmSessions: true,
  supportsLocalAgentJwt: true,
  models,
  agentConfigurationDoc,
};

export default claudeLocalAdapter;
