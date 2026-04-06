/**
 * Example 1: Simple Single-Agent Runner
 *
 * Registers a Claude agent, invokes it with a prompt, and prints the result.
 * This is the "hello world" of agent-orchestrator.
 *
 * Usage:
 *   npx tsx examples/01-single-agent-runner.ts
 *
 * Prerequisites:
 *   - `claude` CLI installed and authenticated
 *   - ANTHROPIC_API_KEY set (or Claude CLI already logged in)
 */

import {
  createOrchestrator,
  claudeLocalAdapter,
  MemoryStore,
} from "../src/index.js";

async function main() {
  // 1. Create an orchestrator with a single adapter
  const orchestrator = createOrchestrator({
    store: new MemoryStore(),
    adapters: [claudeLocalAdapter],
    workspace: { defaultCwd: process.cwd() },
  });

  // 2. Listen for lifecycle events
  orchestrator.on("run.started", (run) => {
    console.log(`[event] Run ${run.id} started`);
  });

  orchestrator.on("run.completed", (run) => {
    console.log(`[event] Run ${run.id} completed (exit: ${run.exitCode})`);
    if (run.stdoutExcerpt) {
      console.log("\n--- Agent Output ---");
      console.log(run.stdoutExcerpt);
      console.log("--- End Output ---\n");
    }
  });

  orchestrator.on("run.failed", (run) => {
    console.error(`[event] Run ${run.id} failed: ${run.error}`);
  });

  // 3. Register an agent
  const agent = await orchestrator.registerAgent({
    name: "hello-agent",
    tenantId: "example-co",
    adapterType: "claude_local",
    adapterConfig: {
      model: "sonnet",
      maxTurns: 1,
      // In production, remove dangerouslySkipPermissions and use allowlists
      dangerouslySkipPermissions: true,
    },
  });

  console.log(`Registered agent: ${agent.name} (${agent.id})`);

  // 4. Invoke the agent — this queues a run and executes it
  const run = await orchestrator.invoke(agent.id, {
    source: "on_demand",
    prompt: "Say hello and tell me what time it is. Keep it brief.",
  });

  if (run) {
    console.log(`Invoked run: ${run.id} (status: ${run.status})`);

    // 5. Wait for the run to finish (poll store)
    let current = await orchestrator.store.getRun(run.id);
    while (current && (current.status === "queued" || current.status === "running")) {
      await new Promise((r) => setTimeout(r, 1000));
      current = await orchestrator.store.getRun(run.id);
    }

    console.log(`\nFinal status: ${current?.status}`);
    if (current?.usageJson) {
      const usage = current.usageJson as Record<string, number>;
      console.log(
        `Tokens — input: ${usage.inputTokens ?? 0}, output: ${usage.outputTokens ?? 0}`,
      );
    }
  } else {
    console.log("No run was created (agent may already be running).");
  }
}

main().catch(console.error);
