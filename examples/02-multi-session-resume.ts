/**
 * Example 2: Multi-Session with Resume
 *
 * Demonstrates session persistence across multiple runs:
 *   - Run 1: Agent starts a task, session is saved
 *   - Run 2: Agent resumes the same session (same taskKey)
 *   - Run 3: Different taskKey → fresh session
 *   - Run 4: Force session reset via compaction policy
 *
 * This example uses a mock adapter to make it runnable without any CLI tools.
 *
 * Usage:
 *   npx tsx examples/02-multi-session-resume.ts
 */

import {
  createOrchestrator,
  MemoryStore,
  type ServerAdapterModule,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  type AdapterEnvironmentTestContext,
  type AdapterEnvironmentTestResult,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock adapter that simulates session resume behavior
// ---------------------------------------------------------------------------

let invocationCount = 0;

const mockAdapter: ServerAdapterModule = {
  type: "mock",

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    invocationCount++;
    const resuming = ctx.runtime.sessionId != null && ctx.runtime.sessionId !== "";
    const sessionId = ctx.runtime.sessionId || `session-${Date.now()}`;

    const log = (msg: string) => ctx.onLog("stdout", msg + "\n");

    await log(`[mock-agent] Invocation #${invocationCount}`);
    await log(`[mock-agent] Task key: ${ctx.runtime.taskKey}`);
    await log(`[mock-agent] Resuming session: ${resuming ? sessionId : "no (fresh)"}`);

    if (ctx.runtime.sessionParams) {
      await log(
        `[mock-agent] Previous session state: ${JSON.stringify(ctx.runtime.sessionParams)}`,
      );
    }

    // Simulate work
    await new Promise((r) => setTimeout(r, 100));

    const prevStep = (ctx.runtime.sessionParams?.step as number) ?? 0;
    const newStep = prevStep + 1;

    await log(`[mock-agent] Completed step ${newStep}`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId,
      sessionParams: {
        step: newStep,
        history: [
          ...((ctx.runtime.sessionParams?.history as string[]) ?? []),
          `step-${newStep}-at-${new Date().toISOString()}`,
        ],
      },
      sessionDisplayId: `mock-${sessionId.slice(-6)}`,
      usage: {
        inputTokens: 500 * newStep,
        outputTokens: 200 * newStep,
        cachedInputTokens: 100 * newStep,
      },
    };
  },

  async testEnvironment(
    _ctx: AdapterEnvironmentTestContext,
  ): Promise<AdapterEnvironmentTestResult> {
    return { status: "pass", checks: [] };
  },

  sessionCodec: {
    deserialize(raw: unknown): Record<string, unknown> | null {
      if (raw && typeof raw === "object") return raw as Record<string, unknown>;
      return null;
    },
    serialize(
      params: Record<string, unknown> | null,
    ): Record<string, unknown> | null {
      return params;
    },
    getDisplayId(params: Record<string, unknown> | null): string | null {
      return params?.step ? `step-${params.step}` : null;
    },
  },

  models: [{ id: "mock-v1", name: "Mock Model v1" }],
};

// ---------------------------------------------------------------------------
// Helper to run an agent and wait for completion
// ---------------------------------------------------------------------------

async function invokeAndWait(
  orchestrator: ReturnType<typeof createOrchestrator>,
  agentId: string,
  opts: { source: string; taskKey?: string; prompt?: string },
) {
  const run = await orchestrator.invoke(agentId, {
    source: opts.source as "on_demand",
    taskKey: opts.taskKey,
    prompt: opts.prompt,
  });

  if (!run) {
    console.log("  -> No run created\n");
    return null;
  }

  // Wait for completion
  let current = await orchestrator.store.getRun(run.id);
  while (current && (current.status === "queued" || current.status === "running")) {
    await new Promise((r) => setTimeout(r, 50));
    current = await orchestrator.store.getRun(run.id);
  }

  return current;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const store = new MemoryStore();

  const orchestrator = createOrchestrator({
    store,
    adapters: [mockAdapter],
    workspace: { defaultCwd: process.cwd() },
  });

  // Log events
  orchestrator.on("run.completed", (run) => {
    console.log(`  [event] Run ${run.id.slice(0, 8)}… completed`);
  });
  orchestrator.on("session.rotated", (_agentId, reason) => {
    console.log(`  [event] Session rotated: ${reason}`);
  });

  // Register agent
  const agent = await orchestrator.registerAgent({
    name: "session-demo-agent",
    tenantId: "example-co",
    adapterType: "mock",
    adapterConfig: {},
  });

  console.log(`Agent: ${agent.name} (${agent.id.slice(0, 8)}…)\n`);

  // ── Run 1: Fresh session for task "project-alpha" ──
  console.log("═══ Run 1: Fresh session (taskKey=project-alpha) ═══");
  const run1 = await invokeAndWait(orchestrator, agent.id, {
    source: "on_demand",
    taskKey: "project-alpha",
    prompt: "Start working on project alpha",
  });
  console.log(`  Status: ${run1?.status}`);
  console.log(`  Session after: ${run1?.sessionIdAfter ?? "none"}\n`);

  // ── Run 2: Resume same task → session continues ──
  console.log("═══ Run 2: Resume session (same taskKey=project-alpha) ═══");
  const run2 = await invokeAndWait(orchestrator, agent.id, {
    source: "on_demand",
    taskKey: "project-alpha",
    prompt: "Continue working on project alpha",
  });
  console.log(`  Status: ${run2?.status}`);
  console.log(`  Session after: ${run2?.sessionIdAfter ?? "none"}\n`);

  // ── Run 3: Different task → new session ──
  console.log("═══ Run 3: Different task (taskKey=project-beta) ═══");
  const run3 = await invokeAndWait(orchestrator, agent.id, {
    source: "on_demand",
    taskKey: "project-beta",
    prompt: "Start working on project beta",
  });
  console.log(`  Status: ${run3?.status}`);
  console.log(`  Session after: ${run3?.sessionIdAfter ?? "none"}\n`);

  // ── Run 4: Back to alpha — session should still be there ──
  console.log("═══ Run 4: Return to project-alpha (session resume) ═══");
  const run4 = await invokeAndWait(orchestrator, agent.id, {
    source: "on_demand",
    taskKey: "project-alpha",
    prompt: "Pick up where we left off on project alpha",
  });
  console.log(`  Status: ${run4?.status}`);
  console.log(`  Session after: ${run4?.sessionIdAfter ?? "none"}\n`);

  // ── Print session state summary ──
  console.log("═══ Session Summary ═══");
  const alphaSession = await store.getTaskSession(
    agent.tenantId,
    agent.id,
    "mock",
    "project-alpha",
  );
  const betaSession = await store.getTaskSession(
    agent.tenantId,
    agent.id,
    "mock",
    "project-beta",
  );

  if (alphaSession) {
    console.log(`  project-alpha: ${alphaSession.runCount} runs, params:`,
      JSON.stringify(alphaSession.sessionParamsJson));
  }
  if (betaSession) {
    console.log(`  project-beta:  ${betaSession.runCount} runs, params:`,
      JSON.stringify(betaSession.sessionParamsJson));
  }

  console.log("\nDone!");
}

main().catch(console.error);
