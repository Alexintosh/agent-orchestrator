/**
 * Test that all 7 bundled adapters load and export correctly.
 * This test is heavier as it imports all adapter implementations.
 */
import { describe, it, expect } from "vitest";
import { adapters } from "../src/adapters/all.js";

describe("Bundled adapters", () => {
  it("exports all 7 adapter types", () => {
    expect(Object.keys(adapters)).toEqual([
      "claudeLocal",
      "codexLocal",
      "cursorLocal",
      "geminiLocal",
      "opencodeLocal",
      "piLocal",
      "openclawGateway",
    ]);
  });

  it("each adapter has the correct type string", () => {
    expect(adapters.claudeLocal.type).toBe("claude_local");
    expect(adapters.codexLocal.type).toBe("codex_local");
    expect(adapters.cursorLocal.type).toBe("cursor");
    expect(adapters.geminiLocal.type).toBe("gemini_local");
    expect(adapters.opencodeLocal.type).toBe("opencode_local");
    expect(adapters.piLocal.type).toBe("pi_local");
    expect(adapters.openclawGateway.type).toBe("openclaw_gateway");
  });

  it("each adapter has execute and testEnvironment functions", () => {
    for (const [key, adapter] of Object.entries(adapters)) {
      expect(typeof adapter.execute, `${key}.execute`).toBe("function");
      expect(typeof adapter.testEnvironment, `${key}.testEnvironment`).toBe("function");
    }
  });

  it("each adapter has models defined", () => {
    for (const [key, adapter] of Object.entries(adapters)) {
      const hasModels = (adapter.models && adapter.models.length > 0) || typeof adapter.listModels === "function";
      expect(hasModels, `${key} should have models or listModels`).toBe(true);
    }
  });
});
