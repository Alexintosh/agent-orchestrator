/**
 * Example 3: Agent Identity from Markdown
 *
 * Shows how to give an agent a rich identity by composing markdown files,
 * similar to how Paperclip provisions agents with AGENT.md instruction files.
 *
 * The pattern:
 *   1. Write an AGENT.md that defines the agent's role, personality, and rules
 *   2. Pass it via `adapterConfig.instructionsFilePath` (Claude adapter)
 *      or via `adapterConfig.promptTemplate` (all adapters)
 *   3. The adapter injects this as a system prompt extension
 *
 * Usage:
 *   npx tsx examples/03-agent-identity-from-markdown.ts
 *
 * Prerequisites:
 *   - `claude` CLI installed and authenticated
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  createOrchestrator,
  claudeLocalAdapter,
  MemoryStore,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Step 1: Define the agent identity as markdown
// ---------------------------------------------------------------------------

const AGENT_IDENTITY = `# Code Review Agent

## Role
You are a senior code reviewer. Your job is to review code changes for correctness, readability, and adherence to best practices.

## Personality
- Direct and constructive — flag issues clearly, suggest fixes
- Pragmatic — don't nitpick style if it's consistent within the file
- Security-aware — always flag potential vulnerabilities

## Rules
1. Never approve code with known security vulnerabilities
2. Prefer suggesting improvements over rewriting entire blocks
3. If a file is too large to review meaningfully, say so
4. Always explain *why* something is a problem, not just *what*

## Output Format
Structure your review as:

### Summary
One-paragraph overview of the change.

### Issues
Bulleted list of problems found (with severity: critical / warning / nit).

### Suggestions
Optional improvements that aren't blocking.
`;

// ---------------------------------------------------------------------------
// Step 2: Write identity to a temp file and register the agent
// ---------------------------------------------------------------------------

async function main() {
  // Write the identity markdown to a temp directory
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-identity-"));
  const identityPath = path.join(tmpDir, "AGENT.md");
  await fs.writeFile(identityPath, AGENT_IDENTITY, "utf-8");

  console.log(`Agent identity written to: ${identityPath}\n`);

  const orchestrator = createOrchestrator({
    store: new MemoryStore(),
    adapters: [claudeLocalAdapter],
    workspace: { defaultCwd: process.cwd() },
  });

  orchestrator.on("run.completed", (run) => {
    console.log(`[event] Run completed (exit: ${run.exitCode})`);
    if (run.stdoutExcerpt) {
      console.log("\n--- Agent Output ---");
      console.log(run.stdoutExcerpt);
      console.log("--- End Output ---\n");
    }
  });

  // ---------------------------------------------------------------------------
  // Option A: instructionsFilePath (Claude adapter)
  //
  // The Claude adapter reads the file and passes it via
  // --append-system-prompt-file, so Claude CLI receives the full identity
  // as part of its system prompt. This is the recommended approach for
  // Claude — it keeps the identity out of the user-turn prompt.
  // ---------------------------------------------------------------------------

  const reviewerA = await orchestrator.registerAgent({
    name: "code-reviewer-instructions-file",
    role: "Senior Code Reviewer",
    adapterType: "claude_local",
    adapterConfig: {
      model: "sonnet",
      maxTurnsPerRun: 3,
      dangerouslySkipPermissions: true,
      instructionsFilePath: identityPath,
    },
  });

  console.log("=== Option A: instructionsFilePath ===");
  console.log(`Agent: ${reviewerA.name} (${reviewerA.id.slice(0, 8)}...)`);
  console.log(`Identity file: ${identityPath}\n`);

  // ---------------------------------------------------------------------------
  // Option B: promptTemplate (all adapters)
  //
  // Embeds the identity directly into the prompt template. Works with any
  // adapter. The template supports {{variable}} interpolation with access
  // to agent, run, and context data.
  // ---------------------------------------------------------------------------

  const identityAsPrompt = AGENT_IDENTITY + `
---

## Current Task

Review the following code and provide your assessment.

Agent: {{agent.name}} ({{agent.id}})
Task: {{context.taskKey}}
`;

  const reviewerB = await orchestrator.registerAgent({
    name: "code-reviewer-prompt-template",
    role: "Senior Code Reviewer",
    adapterType: "claude_local",
    adapterConfig: {
      model: "sonnet",
      maxTurnsPerRun: 3,
      dangerouslySkipPermissions: true,
      promptTemplate: identityAsPrompt,
    },
  });

  console.log("=== Option B: promptTemplate ===");
  console.log(`Agent: ${reviewerB.name} (${reviewerB.id.slice(0, 8)}...)\n`);

  // ---------------------------------------------------------------------------
  // Invoke Option A — ask the agent to review a snippet
  // ---------------------------------------------------------------------------

  console.log("=== Invoking agent (Option A: instructionsFilePath) ===\n");

  const run = await orchestrator.invoke(reviewerA.id, {
    source: "on_demand",
    taskKey: "review-auth-handler",
    prompt: [
      "Review this code for issues:\n",
      "```typescript",
      'app.post("/login", async (req, res) => {',
      "  const { username, password } = req.body;",
      '  const user = await db.query("SELECT * FROM users WHERE username = \'" + username + "\'");',
      "  if (user && user.password === password) {",
      '    const token = jwt.sign({ id: user.id, role: user.role }, "secret123");',
      "    res.json({ token });",
      "  } else {",
      '    res.status(401).json({ error: "Invalid credentials" });',
      "  }",
      "});",
      "```",
    ].join("\n"),
  });

  if (run) {
    // Wait for completion
    let current = await orchestrator.store.getRun(run.id);
    while (current && (current.status === "queued" || current.status === "running")) {
      await new Promise((r) => setTimeout(r, 1000));
      current = await orchestrator.store.getRun(run.id);
    }
    console.log(`Final status: ${current?.status}`);
  }

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
}

main().catch(console.error);
