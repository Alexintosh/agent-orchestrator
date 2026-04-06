import type {
  AdapterSessionCodec,
  AdapterExecutionResult,
  SessionCompactionPolicy,
  ResolvedWorkspace,
  UsageSummary,
} from "./types.js";
import { parseObject, asBoolean, asNumber } from "./adapters/_shared/utils.js";

// ---------------------------------------------------------------------------
// Session codec helpers
// ---------------------------------------------------------------------------

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeSessionParams(
  params: Record<string, unknown> | null | undefined,
) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

/**
 * Default session codec — passthrough with sessionId extraction.
 */
export const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString(
      (raw as Record<string, unknown> | null)?.sessionId,
    );
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

/**
 * Parse session compaction policy from agent runtime config.
 */
export function parseSessionCompactionPolicy(
  adapterType: string,
  runtimeConfig: Record<string, unknown> | null | undefined,
): SessionCompactionPolicy {
  const rc = parseObject(runtimeConfig);
  const heartbeat = parseObject(rc.heartbeat);
  const compaction = parseObject(
    heartbeat.sessionCompaction ??
      heartbeat.sessionRotation ??
      rc.sessionCompaction,
  );
  const supportsSessions = SESSIONED_LOCAL_ADAPTERS.has(adapterType);
  const enabled =
    compaction.enabled === undefined
      ? supportsSessions
      : asBoolean(compaction.enabled, supportsSessions);

  return {
    enabled,
    maxSessionRuns: Math.max(
      0,
      Math.floor(asNumber(compaction.maxSessionRuns, 200)),
    ),
    maxRawInputTokens: Math.max(
      0,
      Math.floor(asNumber(compaction.maxRawInputTokens, 2_000_000)),
    ),
    maxSessionAgeHours: Math.max(
      0,
      Math.floor(asNumber(compaction.maxSessionAgeHours, 72)),
    ),
  };
}

/**
 * Determine if a wake context should force a fresh session.
 */
export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
): boolean {
  if (contextSnapshot?.forceFreshSession === true) return true;
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

/**
 * Derive a task key from context or payload.
 */
export function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): string | null {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

/**
 * Resolve next session state from adapter execution result.
 */
export function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}): {
  params: Record<string, unknown> | null;
  displayId: string | null;
  legacySessionId: string | null;
} {
  const {
    codec,
    adapterResult,
    previousParams,
    previousDisplayId,
    previousLegacySessionId,
  } = input;

  if (adapterResult.clearSession) {
    return {
      params: null,
      displayId: null,
      legacySessionId: null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious =
    !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams = hasExplicitParams
    ? explicitParams
    : hasExplicitSessionId
      ? explicitSessionId
        ? { sessionId: explicitSessionId }
        : null
      : previousParams;

  const serialized = normalizeSessionParams(
    codec.serialize(normalizeSessionParams(candidateParams) ?? null),
  );
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

/**
 * Normalize raw usage totals from a run result.
 */
export function normalizeUsageTotals(
  usage: UsageSummary | null | undefined,
): { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(
      0,
      Math.floor(asNumber(usage.cachedInputTokens, 0)),
    ),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

/**
 * Enrich a wake context snapshot with additional fields from payload.
 */
export function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: string | undefined;
  triggerDetail: string | null;
  payload: Record<string, unknown> | null;
}): {
  contextSnapshot: Record<string, unknown>;
  taskKey: string | null;
} {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const taskKey = deriveTaskKey(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  const issueId = readNonEmptyString(payload?.issueId);
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueId) {
    contextSnapshot.issueId = issueId;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (
    !readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) &&
    triggerDetail
  ) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return { contextSnapshot, taskKey };
}
