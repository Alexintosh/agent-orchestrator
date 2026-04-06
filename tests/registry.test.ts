import { describe, it, expect } from "vitest";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { ServerAdapterModule } from "../src/types.js";

function mockAdapter(type: string): ServerAdapterModule {
  return {
    type,
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: async () => ({ status: "pass" as const, checks: [] }),
    models: [{ id: `${type}-model`, name: `${type} Model` }],
  };
}

describe("AdapterRegistry", () => {
  it("registers adapters via constructor", () => {
    const registry = new AdapterRegistry([mockAdapter("a"), mockAdapter("b")]);
    expect(registry.listTypes()).toEqual(["a", "b"]);
  });

  it("registers adapters via register()", () => {
    const registry = new AdapterRegistry();
    registry.register(mockAdapter("claude_local"));
    expect(registry.listTypes()).toEqual(["claude_local"]);
  });

  it("gets an adapter by type", () => {
    const adapter = mockAdapter("claude_local");
    const registry = new AdapterRegistry([adapter]);
    expect(registry.get("claude_local")).toBe(adapter);
  });

  it("throws for unknown adapter type", () => {
    const registry = new AdapterRegistry([mockAdapter("claude_local")]);
    expect(() => registry.get("nonexistent")).toThrow(/Unknown adapter type: "nonexistent"/);
  });

  it("find returns null for unknown type", () => {
    const registry = new AdapterRegistry();
    expect(registry.find("nonexistent")).toBeNull();
  });

  it("find returns the adapter for known type", () => {
    const adapter = mockAdapter("test");
    const registry = new AdapterRegistry([adapter]);
    expect(registry.find("test")).toBe(adapter);
  });

  it("listAll returns all registered adapters", () => {
    const a = mockAdapter("a");
    const b = mockAdapter("b");
    const registry = new AdapterRegistry([a, b]);
    expect(registry.listAll()).toEqual([a, b]);
  });

  it("lists models for an adapter", async () => {
    const registry = new AdapterRegistry([mockAdapter("claude_local")]);
    const models = await registry.listModels("claude_local");
    expect(models).toEqual([{ id: "claude_local-model", name: "claude_local Model" }]);
  });

  it("returns empty models for unknown adapter", async () => {
    const registry = new AdapterRegistry();
    const models = await registry.listModels("nonexistent");
    expect(models).toEqual([]);
  });

  it("prefers dynamic listModels over static models", async () => {
    const adapter: ServerAdapterModule = {
      ...mockAdapter("test"),
      listModels: async () => [{ id: "dynamic", name: "Dynamic Model" }],
    };
    const registry = new AdapterRegistry([adapter]);
    const models = await registry.listModels("test");
    expect(models).toEqual([{ id: "dynamic", name: "Dynamic Model" }]);
  });

  it("falls back to static models when listModels returns empty", async () => {
    const adapter: ServerAdapterModule = {
      ...mockAdapter("test"),
      listModels: async () => [],
    };
    const registry = new AdapterRegistry([adapter]);
    const models = await registry.listModels("test");
    expect(models).toEqual([{ id: "test-model", name: "test Model" }]);
  });

  it("listAllModels aggregates across adapters", async () => {
    const registry = new AdapterRegistry([mockAdapter("a"), mockAdapter("b")]);
    const all = await registry.listAllModels();
    expect(all).toHaveLength(2);
    expect(all[0]!.adapterType).toBe("a");
    expect(all[1]!.adapterType).toBe("b");
  });

  it("overwrites existing adapter on re-register", () => {
    const registry = new AdapterRegistry([mockAdapter("test")]);
    const newAdapter = mockAdapter("test");
    registry.register(newAdapter);
    expect(registry.get("test")).toBe(newAdapter);
    expect(registry.listTypes()).toEqual(["test"]);
  });
});
