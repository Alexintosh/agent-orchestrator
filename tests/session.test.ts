import { describe, it, expect } from "vitest";
import {
  defaultSessionCodec,
  parseSessionCompactionPolicy,
  shouldResetTaskSessionForWake,
  deriveTaskKey,
  resolveNextSessionState,
  normalizeUsageTotals,
  enrichWakeContextSnapshot,
} from "../src/session.js";

// ---------------------------------------------------------------------------
// defaultSessionCodec
// ---------------------------------------------------------------------------

describe("defaultSessionCodec", () => {
  describe("deserialize", () => {
    it("returns the object when non-empty", () => {
      expect(defaultSessionCodec.deserialize({ sessionId: "abc", cwd: "/tmp" }))
        .toEqual({ sessionId: "abc", cwd: "/tmp" });
    });

    it("extracts sessionId from a minimal object", () => {
      expect(defaultSessionCodec.deserialize({ sessionId: "abc" }))
        .toEqual({ sessionId: "abc" });
    });

    it("returns null for empty object", () => {
      expect(defaultSessionCodec.deserialize({})).toBeNull();
    });

    it("returns null for null input", () => {
      expect(defaultSessionCodec.deserialize(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(defaultSessionCodec.deserialize(undefined)).toBeNull();
    });
  });

  describe("serialize", () => {
    it("returns the object when non-empty", () => {
      expect(defaultSessionCodec.serialize({ sessionId: "abc" }))
        .toEqual({ sessionId: "abc" });
    });

    it("returns null for empty object", () => {
      expect(defaultSessionCodec.serialize({})).toBeNull();
    });

    it("returns null for null input", () => {
      expect(defaultSessionCodec.serialize(null)).toBeNull();
    });
  });

  describe("getDisplayId", () => {
    it("returns sessionId when present", () => {
      expect(defaultSessionCodec.getDisplayId!({ sessionId: "abc-123" }))
        .toBe("abc-123");
    });

    it("returns null when sessionId is missing", () => {
      expect(defaultSessionCodec.getDisplayId!({ other: "value" })).toBeNull();
    });

    it("returns null for empty sessionId", () => {
      expect(defaultSessionCodec.getDisplayId!({ sessionId: "" })).toBeNull();
    });

    it("returns null for null input", () => {
      expect(defaultSessionCodec.getDisplayId!(null)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// parseSessionCompactionPolicy
// ---------------------------------------------------------------------------

describe("parseSessionCompactionPolicy", () => {
  it("returns defaults for sessioned adapter with no config", () => {
    const policy = parseSessionCompactionPolicy("claude_local", null);
    expect(policy).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("returns disabled for non-sessioned adapter", () => {
    const policy = parseSessionCompactionPolicy("http", null);
    expect(policy.enabled).toBe(false);
  });

  it("respects custom values in runtimeConfig", () => {
    const policy = parseSessionCompactionPolicy("claude_local", {
      sessionCompaction: {
        maxSessionRuns: 50,
        maxRawInputTokens: 500_000,
        maxSessionAgeHours: 24,
      },
    });
    expect(policy).toEqual({
      enabled: true,
      maxSessionRuns: 50,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 24,
    });
  });

  it("respects heartbeat.sessionCompaction nested config", () => {
    const policy = parseSessionCompactionPolicy("codex_local", {
      heartbeat: {
        sessionCompaction: {
          maxSessionRuns: 100,
        },
      },
    });
    expect(policy.maxSessionRuns).toBe(100);
    expect(policy.enabled).toBe(true);
  });

  it("can be explicitly disabled", () => {
    const policy = parseSessionCompactionPolicy("claude_local", {
      sessionCompaction: { enabled: false },
    });
    expect(policy.enabled).toBe(false);
  });

  it("clamps negative values to 0", () => {
    const policy = parseSessionCompactionPolicy("claude_local", {
      sessionCompaction: {
        maxSessionRuns: -5,
        maxRawInputTokens: -100,
        maxSessionAgeHours: -1,
      },
    });
    expect(policy.maxSessionRuns).toBe(0);
    expect(policy.maxRawInputTokens).toBe(0);
    expect(policy.maxSessionAgeHours).toBe(0);
  });

  it("works for all sessioned adapter types", () => {
    for (const type of ["claude_local", "codex_local", "cursor", "gemini_local", "opencode_local", "pi_local"]) {
      const policy = parseSessionCompactionPolicy(type, null);
      expect(policy.enabled).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// shouldResetTaskSessionForWake
// ---------------------------------------------------------------------------

describe("shouldResetTaskSessionForWake", () => {
  it("returns true for forceFreshSession", () => {
    expect(shouldResetTaskSessionForWake({ forceFreshSession: true })).toBe(true);
  });

  it("returns true for issue_assigned wake reason", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("returns false for other wake reasons", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "comment_added" })).toBe(false);
  });

  it("returns false for null context", () => {
    expect(shouldResetTaskSessionForWake(null)).toBe(false);
  });

  it("returns false for undefined context", () => {
    expect(shouldResetTaskSessionForWake(undefined)).toBe(false);
  });

  it("returns false for empty context", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveTaskKey
// ---------------------------------------------------------------------------

describe("deriveTaskKey", () => {
  it("prefers contextSnapshot.taskKey", () => {
    expect(deriveTaskKey({ taskKey: "ctx-key", issueId: "issue-1" }, { taskKey: "payload-key" }))
      .toBe("ctx-key");
  });

  it("falls back to contextSnapshot.taskId", () => {
    expect(deriveTaskKey({ taskId: "task-1" }, null)).toBe("task-1");
  });

  it("falls back to contextSnapshot.issueId", () => {
    expect(deriveTaskKey({ issueId: "issue-1" }, null)).toBe("issue-1");
  });

  it("falls back to payload fields", () => {
    expect(deriveTaskKey(null, { taskKey: "payload-key" })).toBe("payload-key");
    expect(deriveTaskKey(null, { taskId: "payload-tid" })).toBe("payload-tid");
    expect(deriveTaskKey(null, { issueId: "payload-iid" })).toBe("payload-iid");
  });

  it("returns null when nothing matches", () => {
    expect(deriveTaskKey(null, null)).toBeNull();
    expect(deriveTaskKey({}, {})).toBeNull();
  });

  it("ignores empty strings", () => {
    expect(deriveTaskKey({ taskKey: "" }, { taskKey: "   " })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveNextSessionState
// ---------------------------------------------------------------------------

describe("resolveNextSessionState", () => {
  const codec = defaultSessionCodec;

  it("clears session when clearSession is true", () => {
    const result = resolveNextSessionState({
      codec,
      adapterResult: { exitCode: 0, signal: null, timedOut: false, clearSession: true },
      previousParams: { sessionId: "old" },
      previousDisplayId: "old-display",
      previousLegacySessionId: "old-session",
    });
    expect(result.params).toBeNull();
    expect(result.displayId).toBeNull();
    expect(result.legacySessionId).toBeNull();
  });

  it("uses explicit sessionParams from adapter result", () => {
    const result = resolveNextSessionState({
      codec,
      adapterResult: {
        exitCode: 0, signal: null, timedOut: false,
        sessionParams: { sessionId: "new-sid", cwd: "/new" },
      },
      previousParams: { sessionId: "old" },
      previousDisplayId: "old-display",
      previousLegacySessionId: "old-session",
    });
    expect(result.params).toEqual({ sessionId: "new-sid", cwd: "/new" });
    expect(result.legacySessionId).toBe("new-sid");
  });

  it("uses explicit sessionId when sessionParams not provided", () => {
    const result = resolveNextSessionState({
      codec,
      adapterResult: {
        exitCode: 0, signal: null, timedOut: false,
        sessionId: "explicit-session",
      },
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    });
    expect(result.params).toEqual({ sessionId: "explicit-session" });
    expect(result.legacySessionId).toBe("explicit-session");
  });

  it("falls back to previous params when nothing explicit", () => {
    const result = resolveNextSessionState({
      codec,
      adapterResult: { exitCode: 0, signal: null, timedOut: false },
      previousParams: { sessionId: "prev", cwd: "/old" },
      previousDisplayId: "prev-display",
      previousLegacySessionId: "prev-session",
    });
    expect(result.params).toEqual({ sessionId: "prev", cwd: "/old" });
    expect(result.displayId).toBe("prev");
  });

  it("returns null params when nothing available", () => {
    const result = resolveNextSessionState({
      codec,
      adapterResult: { exitCode: 0, signal: null, timedOut: false },
      previousParams: null,
      previousDisplayId: null,
      previousLegacySessionId: null,
    });
    expect(result.params).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeUsageTotals
// ---------------------------------------------------------------------------

describe("normalizeUsageTotals", () => {
  it("normalizes valid usage", () => {
    expect(normalizeUsageTotals({
      inputTokens: 100.7,
      outputTokens: 50.3,
      cachedInputTokens: 25.9,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 25,
    });
  });

  it("clamps negative values to 0", () => {
    expect(normalizeUsageTotals({
      inputTokens: -10,
      outputTokens: -5,
      cachedInputTokens: -1,
    })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("returns null for null input", () => {
    expect(normalizeUsageTotals(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeUsageTotals(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichWakeContextSnapshot
// ---------------------------------------------------------------------------

describe("enrichWakeContextSnapshot", () => {
  it("enriches empty context with all fields", () => {
    const result = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: "comment_added",
      source: "webhook",
      triggerDetail: "github",
      payload: { issueId: "issue-42", taskKey: "task-abc" },
    });

    expect(result.contextSnapshot.wakeReason).toBe("comment_added");
    expect(result.contextSnapshot.issueId).toBe("issue-42");
    expect(result.contextSnapshot.taskKey).toBe("task-abc");
    expect(result.contextSnapshot.wakeSource).toBe("webhook");
    expect(result.contextSnapshot.wakeTriggerDetail).toBe("github");
    expect(result.taskKey).toBe("task-abc");
  });

  it("does not overwrite existing context fields", () => {
    const result = enrichWakeContextSnapshot({
      contextSnapshot: { wakeReason: "existing", issueId: "existing-issue" },
      reason: "new-reason",
      source: "api",
      triggerDetail: null,
      payload: { issueId: "new-issue" },
    });

    expect(result.contextSnapshot.wakeReason).toBe("existing");
    expect(result.contextSnapshot.issueId).toBe("existing-issue");
  });

  it("derives taskKey from payload when context has none", () => {
    const result = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: null,
      source: undefined,
      triggerDetail: null,
      payload: { issueId: "issue-99" },
    });
    expect(result.taskKey).toBe("issue-99");
  });

  it("returns null taskKey when nothing derivable", () => {
    const result = enrichWakeContextSnapshot({
      contextSnapshot: {},
      reason: null,
      source: undefined,
      triggerDetail: null,
      payload: null,
    });
    expect(result.taskKey).toBeNull();
  });
});
