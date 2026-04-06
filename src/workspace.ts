import path from "node:path";
import { promises as fs } from "node:fs";
import type { WorkspaceResolver, RunContext } from "./interfaces/workspace.js";
import type { Agent, ResolvedWorkspace } from "./types.js";

/**
 * Simple workspace resolver — uses a configured default CWD.
 * For more complex logic (project workspaces, git worktrees), implement WorkspaceResolver.
 */
export class SimpleWorkspaceResolver implements WorkspaceResolver {
  private defaultCwd: string;
  private agentWorkspaceBase?: string;

  constructor(opts: { defaultCwd: string; agentWorkspaceBase?: string }) {
    this.defaultCwd = opts.defaultCwd;
    this.agentWorkspaceBase = opts.agentWorkspaceBase;
  }

  async resolve(
    agent: Agent,
    context: RunContext,
  ): Promise<ResolvedWorkspace> {
    // Use session CWD if available (to resume in the same directory)
    if (context.sessionCwd) {
      return {
        cwd: context.sessionCwd,
        source: "task_session",
        warnings: [],
      };
    }

    // Use per-agent workspace directory if base is configured
    if (this.agentWorkspaceBase) {
      const agentDir = path.join(this.agentWorkspaceBase, agent.id);
      return {
        cwd: agentDir,
        source: "agent_home",
        warnings: [],
      };
    }

    // Fall back to configured default
    return {
      cwd: this.defaultCwd,
      source: "configured",
      warnings: [],
    };
  }

  async realize(workspace: ResolvedWorkspace): Promise<string> {
    const cwd = workspace.cwd;
    try {
      const stats = await fs.stat(cwd);
      if (!stats.isDirectory()) {
        throw new Error(`Workspace path is not a directory: "${cwd}"`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.mkdir(cwd, { recursive: true });
      } else {
        throw err;
      }
    }
    return cwd;
  }
}
