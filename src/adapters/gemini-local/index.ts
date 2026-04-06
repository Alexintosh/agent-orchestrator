// ---------------------------------------------------------------------------
// Gemini Local Adapter — self-contained port from Paperclip's gemini-local adapter.
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
  listSkillEntries,
  ensureSkillSymlink,
  removeMaintainerOnlySkillSymlinks,
} from "../_shared/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_GEMINI_LOCAL_MODEL = "auto";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveGeminiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "GEMINI_API_KEY") || hasNonEmptyEnvValue(env, "GOOGLE_API_KEY")
    ? "api"
    : "subscription";
}

function renderAgentEnvNote(env: Record<string, string>): string {
  const agentKeys = Object.keys(env)
    .filter((key) => key.startsWith("ORCHESTRATOR_") || key.startsWith("PAPERCLIP_"))
    .sort();
  if (agentKeys.length === 0) return "";
  return [
    "Agent runtime note:",
    `The following agent environment variables are available in this run: ${agentKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  const hasUrl = hasNonEmptyEnvValue(env, "ORCHESTRATOR_API_URL") || hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL");
  const hasKey = hasNonEmptyEnvValue(env, "ORCHESTRATOR_API_KEY") || hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY");
  if (!hasUrl || !hasKey) return "";
  return [
    "API access note:",
    "Use run_shell_command with curl to make API requests.",
    "GET example:",
    `  run_shell_command({ command: "curl -s -H \\"Authorization: Bearer $ORCHESTRATOR_API_KEY\\" \\"$ORCHESTRATOR_API_URL/api/agents/me\\"" })`,
    "POST/PATCH example:",
    `  run_shell_command({ command: "curl -s -X POST -H \\"Authorization: Bearer $ORCHESTRATOR_API_KEY\\" -H 'Content-Type: application/json' -H \\"X-Run-Id: $ORCHESTRATOR_RUN_ID\\" -d '{...}' \\"$ORCHESTRATOR_API_URL/api/issues/{id}/checkout\\"" })`,
    "",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Skills injection into ~/.gemini/skills/
// ---------------------------------------------------------------------------

function geminiSkillsHome(): string {
  return path.join(os.homedir(), ".gemini", "skills");
}

/**
 * Inject skills directly into `~/.gemini/skills/` via symlinks.
 * This avoids needing GEMINI_CLI_HOME overrides, so the CLI naturally finds
 * both its auth credentials and the injected skills in the real home directory.
 */
async function ensureGeminiSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const skillsEntries = await listSkillEntries(__moduleDir);
  if (skillsEntries.length === 0) return;

  const skillsHome = geminiSkillsHome();
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[orchestrator] Failed to prepare Gemini skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.name),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[orchestrator] Removed maintainer-only Gemini skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.name);

    try {
      const result = await ensureSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[orchestrator] ${result === "repaired" ? "Repaired" : "Linked"} Gemini skill: ${entry.name}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[orchestrator] Failed to link Gemini skill "${entry.name}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Output parsing (inlined from parse.ts)
// ---------------------------------------------------------------------------

function collectMessageText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = parseObject(message);
  const direct = asString(record.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text, "").trim() || asString(part.content, "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.sessionID, "").trim() ||
    asString(event.checkpoint_id, "").trim() ||
    asString(event.thread_id, "").trim() ||
    null
  );
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function accumulateUsage(
  target: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageRaw: unknown,
) {
  const usage = parseObject(usageRaw);
  const usageMetadata = parseObject(usage.usageMetadata);
  const source = Object.keys(usageMetadata).length > 0 ? usageMetadata : usage;

  target.inputTokens += asNumber(
    source.input_tokens,
    asNumber(source.inputTokens, asNumber(source.promptTokenCount, 0)),
  );
  target.cachedInputTokens += asNumber(
    source.cached_input_tokens,
    asNumber(source.cachedInputTokens, asNumber(source.cachedContentTokenCount, 0)),
  );
  target.outputTokens += asNumber(
    source.output_tokens,
    asNumber(source.outputTokens, asNumber(source.candidatesTokenCount, 0)),
  );
}

function parseGeminiJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  let question: { prompt: string; choices: Array<{ key: string; label: string; description?: string }> } | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const foundSessionId = readSessionId(event);
    if (foundSessionId) sessionId = foundSessionId;

    const type = asString(event.type, "").trim();

    if (type === "assistant") {
      messages.push(...collectMessageText(event.message));
      const messageObj = parseObject(event.message);
      const content = Array.isArray(messageObj.content) ? messageObj.content : [];
      for (const partRaw of content) {
        const part = parseObject(partRaw);
        if (asString(part.type, "").trim() === "question") {
          question = {
            prompt: asString(part.prompt, "").trim(),
            choices: (Array.isArray(part.choices) ? part.choices : []).map((choiceRaw) => {
              const choice = parseObject(choiceRaw);
              return {
                key: asString(choice.key, "").trim(),
                label: asString(choice.label, "").trim(),
                description: asString(choice.description, "").trim() || undefined,
              };
            }),
          };
          break; // only one question per message
        }
      }
      continue;
    }

    if (type === "result") {
      resultEvent = event;
      accumulateUsage(usage, event.usage ?? event.usageMetadata);
      const resultText =
        asString(event.result, "").trim() ||
        asString(event.text, "").trim() ||
        asString(event.response, "").trim();
      if (resultText && messages.length === 0) messages.push(resultText);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      const isError = event.is_error === true || asString(event.subtype, "").toLowerCase() === "error";
      if (isError) {
        const text = asErrorText(event.error ?? event.message ?? event.result).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "error") {
      const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
      if (text) errorMessage = text;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event.subtype, "").trim().toLowerCase();
      if (subtype === "error") {
        const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish" || event.usage || event.usageMetadata) {
      accumulateUsage(usage, event.usage ?? event.usageMetadata);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage,
    resultEvent,
    question,
  };
}

function isGeminiUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|checkpoint\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume/i.test(
    haystack,
  );
}

function extractGeminiErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const errorMsg = asString(parsed.error, "").trim();
  if (errorMsg) messages.push(errorMsg);

  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
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

function describeGeminiFailure(parsed: Record<string, unknown>): string | null {
  const status = asString(parsed.status, "");
  const errors = extractGeminiErrorMessages(parsed);

  const detail = errors[0] ?? "";
  const parts = ["Gemini run failed"];
  if (status) parts.push(`status=${status}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

const GEMINI_AUTH_REQUIRED_RE = /(?:not\s+authenticated|please\s+authenticate|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|unauthorized|invalid\s+credentials|not\s+logged\s+in|login\s+required|run\s+`?gemini\s+auth(?:\s+login)?`?\s+first)/i;

function detectGeminiAuthRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresAuth = messages.some((line) => GEMINI_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}

function isGeminiTurnLimitResult(
  parsed: Record<string, unknown> | null | undefined,
  exitCode?: number | null,
): boolean {
  if (exitCode === 53) return true;
  if (!parsed) return false;

  const status = asString(parsed.status, "").trim().toLowerCase();
  if (status === "turn_limit" || status === "max_turns") return true;

  const error = asString(parsed.error, "").trim();
  return /turn\s*limit|max(?:imum)?\s+turns?/i.test(error);
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your work.",
  );
  const command = asString(config.command, "gemini");
  const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
  const sandbox = asBoolean(config.sandbox, false);

  const workspaceContext = parseObject(context.orchestratorWorkspace ?? context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const rawHints = (context.orchestratorWorkspaces ?? context.paperclipWorkspaces) as unknown;
  const workspaceHints = Array.isArray(rawHints)
    ? (rawHints as unknown[]).filter(
      (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
    )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  await ensureGeminiSkillsInjected(onLog);

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
  if (wakeTaskId) env.ORCHESTRATOR_TASK_ID = wakeTaskId;
  if (wakeReason) env.ORCHESTRATOR_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.ORCHESTRATOR_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.ORCHESTRATOR_APPROVAL_ID = approvalId;
  if (approvalStatus) env.ORCHESTRATOR_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.ORCHESTRATOR_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd) env.ORCHESTRATOR_WORKSPACE_CWD = effectiveWorkspaceCwd;
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
  const billingType = resolveGeminiBillingType(env);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

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
      `[orchestrator] Gemini session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      await onLog(
        "stderr",
        `[orchestrator] Loaded agent instructions file: ${instructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[orchestrator] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const commandNotes = (() => {
    const notes: string[] = ["Prompt is passed to Gemini as the final positional argument."];
    notes.push("Added --approval-mode yolo for unattended execution.");
    if (!instructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
      return notes;
    }
    notes.push(
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    );
    return notes;
  })();

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
  const sessionHandoffNote = asString(context.sessionHandoffMarkdown ?? context.paperclipSessionHandoffMarkdown, "").trim();
  const agentEnvNote = renderAgentEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    agentEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: agentEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["--output-format", "stream-json"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
    args.push("--approval-mode", "yolo");
    if (sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--sandbox=none");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push(prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "gemini_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args.map((value, index) => (
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
        )),
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
    });
    return {
      proc,
      parsed: parseGeminiJsonl(proc.stdout),
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
      parsed: ReturnType<typeof parseGeminiJsonl>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    const authMeta = detectGeminiAuthRequired({
      parsed: attempt.parsed.resultEvent,
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth ? "gemini_auth_required" : null,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const clearSessionForTurnLimit = isGeminiTurnLimitResult(attempt.parsed.resultEvent, attempt.proc.exitCode);

    // On retry, don't fall back to old session ID — the old session was stale
    const canFallbackToRuntimeSession = !isRetry;
    const resolvedSessionId = attempt.parsed.sessionId
      ?? (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const structuredFailure = attempt.parsed.resultEvent
      ? describeGeminiFailure(attempt.parsed.resultEvent)
      : null;
    const fallbackErrorMessage =
      parsedError ||
      structuredFailure ||
      stderrLine ||
      `Gemini exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (attempt.proc.exitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      errorCode: (attempt.proc.exitCode ?? 0) !== 0 && authMeta.requiresAuth ? "gemini_auth_required" : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "google",
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      resultJson: attempt.parsed.resultEvent ?? {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      question: attempt.parsed.question,
      clearSession: clearSessionForTurnLimit || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isGeminiUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stderr",
      `[orchestrator] Gemini resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true, true);
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

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean;
}

async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "gemini");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "gemini_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "gemini_cwd_invalid",
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
      code: "gemini_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "gemini_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configGeminiApiKey = env.GEMINI_API_KEY;
  const hostGeminiApiKey = process.env.GEMINI_API_KEY;
  const configGoogleApiKey = env.GOOGLE_API_KEY;
  const hostGoogleApiKey = process.env.GOOGLE_API_KEY;
  const hasGca = env.GOOGLE_GENAI_USE_GCA === "true" || process.env.GOOGLE_GENAI_USE_GCA === "true";
  if (
    isNonEmpty(configGeminiApiKey) ||
    isNonEmpty(hostGeminiApiKey) ||
    isNonEmpty(configGoogleApiKey) ||
    isNonEmpty(hostGoogleApiKey) ||
    hasGca
  ) {
    const source = hasGca
      ? "Google account login (GCA)"
      : isNonEmpty(configGeminiApiKey) || isNonEmpty(configGoogleApiKey)
        ? "adapter config env"
        : "server environment";
    checks.push({
      code: "gemini_api_key_present",
      level: "info",
      message: "Gemini API credentials are set for CLI authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "gemini_api_key_missing",
      level: "info",
      message: "No explicit API key detected. Gemini CLI may still authenticate via `gemini auth login` (OAuth).",
      hint: "If the hello probe fails with an auth error, set GEMINI_API_KEY or GOOGLE_API_KEY in adapter env, or run `gemini auth login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "gemini_cwd_invalid" && check.code !== "gemini_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "gemini")) {
      checks.push({
        code: "gemini_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `gemini`.",
        detail: command,
        hint: "Use the `gemini` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const probeModel = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
      const approvalMode = asString(config.approvalMode, asBoolean(config.yolo, false) ? "yolo" : "default");
      const probeSandbox = asBoolean(config.sandbox, false);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--output-format", "stream-json"];
      if (probeModel && probeModel !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", probeModel);
      if (approvalMode !== "default") args.push("--approval-mode", approvalMode);
      if (probeSandbox) {
        args.push("--sandbox");
      } else {
        args.push("--sandbox=none");
      }
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("Respond with hello.");

      const probe = await runChildProcess(
        `gemini-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => { },
        },
      );
      const parsed = parseGeminiJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectGeminiAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (probe.timedOut) {
        checks.push({
          code: "gemini_hello_probe_timed_out",
          level: "warn",
          message: "Gemini hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Gemini can run `Respond with hello.` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "gemini_hello_probe_passed" : "gemini_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Gemini hello probe succeeded."
            : "Gemini probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `gemini --output-format json \"Respond with hello.\"` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "gemini_hello_probe_auth_required",
          level: "warn",
          message: "Gemini CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `gemini auth` or configure GEMINI_API_KEY / GOOGLE_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "gemini_hello_probe_failed",
          level: "error",
          message: "Gemini hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `gemini --output-format json \"Respond with hello.\"` manually in this working directory to debug.",
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
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.sessionID);
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
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID);
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
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
    );
  },
};

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const models: AdapterModel[] = [
  { id: DEFAULT_GEMINI_LOCAL_MODEL, label: "Auto" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
];

// ---------------------------------------------------------------------------
// Agent configuration documentation
// ---------------------------------------------------------------------------

const agentConfigurationDoc = `# gemini_local agent configuration

Adapter: gemini_local

Use when:
- You want the orchestrator to run the Gemini CLI locally on the host machine
- You want Gemini chat sessions resumed across heartbeats with --resume
- You want skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Gemini CLI is not installed on the machine that runs the orchestrator

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Gemini model id. Defaults to auto.
- sandbox (boolean, optional): run in sandbox mode (default: false, passes --sandbox=none)
- command (string, optional): defaults to "gemini"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use positional prompt arguments, not stdin.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Skills are auto-injected into \`~/.gemini/skills/\` via symlinks, so the CLI can discover both credentials and skills in their natural location.
- Authentication can use GEMINI_API_KEY / GOOGLE_API_KEY or local Gemini CLI login.
`;

// ---------------------------------------------------------------------------
// Exported adapter module
// ---------------------------------------------------------------------------

export const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute,
  testEnvironment,
  sessionCodec,
  supportsDirectLlmSessions: true,
  supportsLocalAgentJwt: false,
  models,
  agentConfigurationDoc,
};

export default geminiLocalAdapter;
