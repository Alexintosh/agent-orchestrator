import type { Agent, ResolvedWorkspace } from "../types.js";

export interface RunContext {
  taskKey: string | null;
  contextSnapshot: Record<string, unknown> | null;
  sessionCwd?: string | null;
}

/**
 * Pluggable workspace resolution strategy.
 * Determines the working directory for agent runs.
 */
export interface WorkspaceResolver {
  /**
   * Resolve the workspace for a given agent and run context.
   * Returns the resolved workspace metadata including the CWD path.
   */
  resolve(agent: Agent, context: RunContext): Promise<ResolvedWorkspace>;

  /**
   * Ensure the workspace directory exists and is ready for use.
   * Called after resolve() to materialize the workspace (create dirs, clone repos, etc.).
   * Returns the absolute path to the working directory.
   */
  realize(workspace: ResolvedWorkspace): Promise<string>;
}
