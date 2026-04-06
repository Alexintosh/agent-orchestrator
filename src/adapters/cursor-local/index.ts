// ---------------------------------------------------------------------------
// Cursor Local Adapter — self-contained port from Paperclip's cursor-local adapter.
// All functionality (execute, testEnvironment, sessionCodec, models, output parsing,
// stream normalization, trust detection, skills injection) is included inline.
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
  asStringArray,
  parseObject,
  parseJson,
  buildAgentEnv,
  joinPromptSections,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  listSkillEntries,
  ensureSkillSymlink,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  runChildProcess,
} from "../_shared/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CURSOR_LOCAL_MODEL = "auto";

// ---------------------------------------------------------------------------
// Inline: stream normalization (from shared/stream.ts)
// ---------------------------------------------------------------------------

function normalizeCursorStreamLine(rawLine: string): {
  stream: "stdout" | "stderr" | null;
  line: string;
} {
  const trimmed = rawLine.trim();
  if (!trimmed) return { stream: null, line: "" };

  const prefixed = trimmed.match(/^(stdout|stderr)\s*[:=]?\s*([\[{].*)$/i);
  if (!prefixed) {
    return { stream: null, line: trimmed };
  }

  const stream = prefixed[1]?.toLowerCase() === "stderr" ? "stderr" : "stdout";
  const line = (prefixed[2] ?? "").trim();
  return { stream, line };
}

// ---------------------------------------------------------------------------
// Inline: trust bypass detection (from shared/trust.ts)
// ---------------------------------------------------------------------------

function hasCursorTrustBypassArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--trust" ||
      arg === "--yolo" ||
      arg === "-f" ||
      arg.startsWith("--trust="),
  );
}

// ---------------------------------------------------------------------------
// Output parsing (inlined from parse.ts)
// ---------------------------------------------------------------------------

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

function collectAssistantText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const rec = parseObject(message);
  const direct = asString(rec.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(rec.content) ? rec.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text") {
      const text = asString(part.text, "").trim();
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
    null
  );
}

function parseCursorJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let totalCostUsd = 0;
  const usage: UsageSummary = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = normalizeCursorStreamLine(rawLine).line;
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const foundSession = readSessionId(event);
    if (foundSession) sessionId = foundSession;

    const type = asString(event.type, "").trim();

    if (type === "assistant") {
      messages.push(...collectAssistantText(event.message));
      continue;
    }

    if (type === "result") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens += asNumber(
        usageObj.input_tokens,
        asNumber(usageObj.inputTokens, 0),
      );
      usage.cachedInputTokens! += asNumber(
        usageObj.cached_input_tokens,
        asNumber(usageObj.cachedInputTokens, asNumber(usageObj.cache_read_input_tokens, 0)),
      );
      usage.outputTokens += asNumber(
        usageObj.output_tokens,
        asNumber(usageObj.outputTokens, 0),
      );
      totalCostUsd += asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, 0)));

      const isError = event.is_error === true || asString(event.subtype, "").toLowerCase() === "error";
      const resultText = asString(event.result, "").trim();
      if (resultText && messages.length === 0) {
        messages.push(resultText);
      }
      if (isError) {
        const resultError = asErrorText(event.error ?? event.message ?? event.result).trim();
        if (resultError) errorMessage = resultError;
      }
      continue;
    }

    if (type === "error") {
      const message = asErrorText(event.message ?? event.error ?? event.detail).trim();
      if (message) errorMessage = message;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event.subtype, "").trim().toLowerCase();
      if (subtype === "error") {
        const message = asErrorText(event.message ?? event.error ?? event.detail).trim();
        if (message) errorMessage = message;
      }
      continue;
    }

    // Compatibility with older stream-json shapes.
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
      usage.cachedInputTokens! += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0);
      totalCostUsd += asNumber(part.cost, 0);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd: totalCostUsd > 0 ? totalCostUsd : null,
    errorMessage,
  };
}

function isCursorUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+(session|chat)|session\s+.*\s+not\s+found|chat\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|could\s+not\s+resume/i.test(
    haystack,
  );
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

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCursorBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "CURSOR_API_KEY") || hasNonEmptyEnvValue(env, "OPENAI_API_KEY")
    ? "api"
    : "subscription";
}

function resolveProviderFromModel(model: string): string | null {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash > 0) return trimmed.slice(0, slash);
  if (trimmed.includes("sonnet") || trimmed.includes("claude")) return "anthropic";
  if (trimmed.startsWith("gpt") || trimmed.startsWith("o")) return "openai";
  return null;
}

function normalizeMode(rawMode: string): "plan" | "ask" | null {
  const mode = rawMode.trim().toLowerCase();
  if (mode === "plan" || mode === "ask") return mode;
  return null;
}

function renderOrchestratorEnvNote(env: Record<string, string>): string {
  const orchestratorKeys = Object.keys(env)
    .filter((key) => key.startsWith("ORCHESTRATOR_"))
    .sort();
  if (orchestratorKeys.length === 0) return "";
  return [
    "Orchestrator runtime note:",
    `The following ORCHESTRATOR_* environment variables are available in this run: ${orchestratorKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Cursor skills injection
// ---------------------------------------------------------------------------

function cursorSkillsHome(): string {
  return path.join(os.homedir(), ".cursor", "skills");
}

type EnsureCursorSkillsInjectedOptions = {
  skillsDir?: string | null;
  skillsEntries?: Array<{ name: string; source: string }>;
  skillsHome?: string;
  linkSkill?: (source: string, target: string) => Promise<void>;
};

async function ensureCursorSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCursorSkillsInjectedOptions = {},
) {
  const skillsEntries = options.skillsEntries
    ?? (options.skillsDir
      ? (await fs.readdir(options.skillsDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, source: path.join(options.skillsDir!, entry.name) }))
      : await listSkillEntries(__moduleDir));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? cursorSkillsHome();
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[orchestrator] Failed to prepare Cursor skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
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
      `[orchestrator] Removed maintainer-only Cursor skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  const linkSkill = options.linkSkill ?? ((source: string, target: string) => fs.symlink(source, target));
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.name);
    try {
      const result = await ensureSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stderr",
        `[orchestrator] ${result === "repaired" ? "Repaired" : "Injected"} Cursor skill "${entry.name}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[orchestrator] Failed to inject Cursor skill "${entry.name}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
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
  const command = asString(config.command, "agent");
  const model = asString(config.model, DEFAULT_CURSOR_LOCAL_MODEL).trim();
  const mode = normalizeMode(asString(config.mode, ""));

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
  await ensureCursorSkillsInjected(onLog);

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
  if (workspaceId) {
    env.ORCHESTRATOR_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.ORCHESTRATOR_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.ORCHESTRATOR_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.ORCHESTRATOR_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  if (!hasExplicitApiKey && authToken) {
    env.ORCHESTRATOR_API_KEY = authToken;
  }
  const billingType = resolveCursorBillingType(env);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const autoTrustEnabled = !hasCursorTrustBypassArg(extraArgs);

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
      `[orchestrator] Cursor session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
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
    const notes: string[] = [];
    if (autoTrustEnabled) {
      notes.push("Auto-added --yolo to bypass interactive prompts.");
    }
    notes.push("Prompt is piped to Cursor via stdin.");
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
  const sessionHandoffNote = asString(context.orchestratorSessionHandoffMarkdown, "").trim();
  const orchestratorEnvNote = renderOrchestratorEnvNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    orchestratorEnvNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: orchestratorEnvNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["-p", "--output-format", "stream-json", "--workspace", cwd];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model) args.push("--model", model);
    if (mode) args.push("--mode", mode);
    if (autoTrustEnabled) args.push("--yolo");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "cursor",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    let stdoutLineBuffer = "";
    const emitNormalizedStdoutLine = async (rawLine: string) => {
      const normalized = normalizeCursorStreamLine(rawLine);
      if (!normalized.line) return;
      await onLog(normalized.stream ?? "stdout", `${normalized.line}\n`);
    };
    const flushStdoutChunk = async (chunk: string, finalize = false) => {
      const combined = `${stdoutLineBuffer}${chunk}`;
      const lines = combined.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        await emitNormalizedStdoutLine(line);
      }

      if (finalize) {
        const trailing = stdoutLineBuffer.trim();
        stdoutLineBuffer = "";
        if (trailing) {
          await emitNormalizedStdoutLine(trailing);
        }
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      stdin: prompt,
      onLog: async (stream, chunk) => {
        if (stream !== "stdout") {
          await onLog(stream, chunk);
          return;
        }
        await flushStdoutChunk(chunk);
      },
    });
    await flushStdoutChunk("", true);

    return {
      proc,
      parsed: parseCursorJsonl(proc.stdout),
    };
  };

  const providerFromModel = resolveProviderFromModel(model);

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };
      parsed: ReturnType<typeof parseCursorJsonl>;
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

    const resolvedSessionId = attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null;
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
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Cursor exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: providerFromModel,
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCursorUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stderr",
      `[orchestrator] Cursor resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
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
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const CURSOR_AUTH_REQUIRED_RE =
  /(?:authentication\s+required|not\s+authenticated|not\s+logged\s+in|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|cursor[_\s-]?api[_\s-]?key|run\s+'?agent\s+login'?\s+first|api(?:[_\s-]?key)?(?:\s+is)?\s+required)/i;

async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agent");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "cursor_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "cursor_cwd_invalid",
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
      code: "cursor_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "cursor_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configCursorApiKey = env.CURSOR_API_KEY;
  const hostCursorApiKey = process.env.CURSOR_API_KEY;
  if (isNonEmpty(configCursorApiKey) || isNonEmpty(hostCursorApiKey)) {
    const source = isNonEmpty(configCursorApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "cursor_api_key_present",
      level: "info",
      message: "CURSOR_API_KEY is set for Cursor authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "cursor_api_key_missing",
      level: "warn",
      message: "CURSOR_API_KEY is not set. Cursor runs may fail until authentication is configured.",
      hint: "Set CURSOR_API_KEY in adapter env or run `agent login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "cursor_cwd_invalid" && check.code !== "cursor_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "agent")) {
      checks.push({
        code: "cursor_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `agent`.",
        detail: command,
        hint: "Use the `agent` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const probeModel = asString(config.model, DEFAULT_CURSOR_LOCAL_MODEL).trim();
      const probeExtraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const autoTrustEnabled = !hasCursorTrustBypassArg(probeExtraArgs);
      const args = ["-p", "--mode", "ask", "--output-format", "json", "--workspace", cwd];
      if (probeModel) args.push("--model", probeModel);
      if (autoTrustEnabled) args.push("--yolo");
      if (probeExtraArgs.length > 0) args.push(...probeExtraArgs);
      args.push("Respond with hello.");

      const probe = await runChildProcess(
        `cursor-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const parsed = parseCursorJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "cursor_hello_probe_timed_out",
          level: "warn",
          message: "Cursor hello probe timed out.",
          hint: "Retry the probe. If this persists, verify `agent -p --mode ask --output-format json \"Respond with hello.\"` manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "cursor_hello_probe_passed" : "cursor_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Cursor hello probe succeeded."
            : "Cursor probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try `agent -p --mode ask --output-format json \"Respond with hello.\"` manually to inspect full output.",
              }),
        });
      } else if (CURSOR_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "cursor_hello_probe_auth_required",
          level: "warn",
          message: "Cursor CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `agent login` or configure CURSOR_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "cursor_hello_probe_failed",
          level: "error",
          message: "Cursor hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `agent -p --mode ask --output-format json \"Respond with hello.\"` manually in this working directory to debug.",
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

const CURSOR_FALLBACK_MODEL_IDS = [
  "auto",
  "composer-1.5",
  "composer-1",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-low-fast",
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-high-fast",
  "gpt-5.3-codex-xhigh",
  "gpt-5.3-codex-xhigh-fast",
  "gpt-5.3-codex-spark-preview",
  "gpt-5.2",
  "gpt-5.2-codex-low",
  "gpt-5.2-codex-low-fast",
  "gpt-5.2-codex",
  "gpt-5.2-codex-fast",
  "gpt-5.2-codex-high",
  "gpt-5.2-codex-high-fast",
  "gpt-5.2-codex-xhigh",
  "gpt-5.2-codex-xhigh-fast",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-max-high",
  "gpt-5.2-high",
  "gpt-5.1-high",
  "gpt-5.1-codex-mini",
  "opus-4.6-thinking",
  "opus-4.6",
  "opus-4.5",
  "opus-4.5-thinking",
  "sonnet-4.6",
  "sonnet-4.6-thinking",
  "sonnet-4.5",
  "sonnet-4.5-thinking",
  "gemini-3.1-pro",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok",
  "kimi-k2.5",
];

const models: AdapterModel[] = CURSOR_FALLBACK_MODEL_IDS.map((id) => ({ id, label: id }));

// ---------------------------------------------------------------------------
// Agent configuration documentation
// ---------------------------------------------------------------------------

const agentConfigurationDoc = `# cursor agent configuration

Adapter: cursor

Use when:
- You want the orchestrator to run Cursor Agent CLI locally as the agent runtime
- You want Cursor chat session resume across heartbeats via --resume
- You want structured stream output in run logs via --output-format stream-json

Don't use when:
- You need webhook-style external invocation (use an HTTP adapter)
- You only need one-shot shell commands (use process)
- Cursor Agent CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Cursor model id (for example auto or gpt-5.3-codex)
- mode (string, optional): Cursor execution mode passed as --mode (plan|ask). Leave unset for normal autonomous runs.
- command (string, optional): defaults to "agent"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: agent -p --output-format stream-json ...
- Prompts are piped to Cursor via stdin.
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- The orchestrator auto-injects local skills into "~/.cursor/skills" when missing, so Cursor can discover skills on local runs.
- The orchestrator auto-adds --yolo unless one of --trust/--yolo/-f is already present in extraArgs.
`;

// ---------------------------------------------------------------------------
// Exported adapter module
// ---------------------------------------------------------------------------

export { ensureCursorSkillsInjected };

export const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute,
  testEnvironment,
  sessionCodec,
  supportsDirectLlmSessions: true,
  supportsLocalAgentJwt: false,
  models,
  agentConfigurationDoc,
};

export default cursorLocalAdapter;
