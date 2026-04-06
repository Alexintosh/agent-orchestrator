import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SimpleWorkspaceResolver } from "../src/workspace.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("SimpleWorkspaceResolver", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const mockAgent = {
    id: "agent-1",
    tenantId: "co-1",
    name: "Test Agent",
    adapterType: "mock",
    adapterConfig: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("resolve", () => {
    it("uses sessionCwd when available", async () => {
      const resolver = new SimpleWorkspaceResolver({ defaultCwd: tmpDir });
      const result = await resolver.resolve(mockAgent, {
        sessionCwd: "/custom/session/dir",
        contextSnapshot: {},
        taskKey: null,
      });
      expect(result.cwd).toBe("/custom/session/dir");
      expect(result.source).toBe("task_session");
    });

    it("uses per-agent workspace when base is configured", async () => {
      const agentBase = path.join(tmpDir, "agents");
      const resolver = new SimpleWorkspaceResolver({
        defaultCwd: tmpDir,
        agentWorkspaceBase: agentBase,
      });
      const result = await resolver.resolve(mockAgent, {
        contextSnapshot: {},
        taskKey: null,
      });
      expect(result.cwd).toBe(path.join(agentBase, "agent-1"));
      expect(result.source).toBe("agent_home");
    });

    it("falls back to defaultCwd", async () => {
      const resolver = new SimpleWorkspaceResolver({ defaultCwd: tmpDir });
      const result = await resolver.resolve(mockAgent, {
        contextSnapshot: {},
        taskKey: null,
      });
      expect(result.cwd).toBe(tmpDir);
      expect(result.source).toBe("configured");
    });

    it("prefers sessionCwd over agentWorkspaceBase", async () => {
      const resolver = new SimpleWorkspaceResolver({
        defaultCwd: tmpDir,
        agentWorkspaceBase: "/agents",
      });
      const result = await resolver.resolve(mockAgent, {
        sessionCwd: "/session/dir",
        contextSnapshot: {},
        taskKey: null,
      });
      expect(result.cwd).toBe("/session/dir");
      expect(result.source).toBe("task_session");
    });
  });

  describe("realize", () => {
    it("returns cwd for an existing directory", async () => {
      const resolver = new SimpleWorkspaceResolver({ defaultCwd: tmpDir });
      const cwd = await resolver.realize({ cwd: tmpDir, source: "configured", warnings: [] });
      expect(cwd).toBe(tmpDir);
    });

    it("creates directory if it does not exist", async () => {
      const newDir = path.join(tmpDir, "new", "nested", "dir");
      const resolver = new SimpleWorkspaceResolver({ defaultCwd: tmpDir });
      const cwd = await resolver.realize({ cwd: newDir, source: "configured", warnings: [] });
      expect(cwd).toBe(newDir);

      const stats = await fs.stat(newDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it("throws for non-directory path", async () => {
      const filePath = path.join(tmpDir, "file.txt");
      await fs.writeFile(filePath, "not a directory");

      const resolver = new SimpleWorkspaceResolver({ defaultCwd: tmpDir });
      await expect(
        resolver.realize({ cwd: filePath, source: "configured", warnings: [] }),
      ).rejects.toThrow("not a directory");
    });
  });
});
