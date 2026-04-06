# Multi-Session with Resume

Demonstrates session persistence across multiple runs using a mock adapter — no CLI tools required.

## Full Source

<<< @/../examples/02-multi-session-resume.ts

## Running

```bash
npx tsx examples/02-multi-session-resume.ts
```

## What This Demonstrates

1. **Session persistence** — Run 1 creates a session, Run 2 resumes it
2. **Task key isolation** — Different `taskKey` values get separate sessions
3. **Session state accumulation** — Each run appends to `history` and increments `step`
4. **Mock adapter** — Shows how to build a test adapter without external dependencies
5. **Session codec** — Custom `serialize`/`deserialize`/`getDisplayId`

## Expected Output

```
Agent: session-demo-agent (a1b2c3d4…)

═══ Run 1: Fresh session (taskKey=project-alpha) ═══
  [event] Run a1b2c3d4… completed
  Status: completed
  Session after: session-1710000000000

═══ Run 2: Resume session (same taskKey=project-alpha) ═══
  [event] Run e5f6g7h8… completed
  Status: completed
  Session after: session-1710000000000

═══ Run 3: Different task (taskKey=project-beta) ═══
  [event] Run i9j0k1l2… completed
  Status: completed
  Session after: session-1710000000100

═══ Run 4: Return to project-alpha (session resume) ═══
  [event] Run m3n4o5p6… completed
  Status: completed
  Session after: session-1710000000000

═══ Session Summary ═══
  project-alpha: 3 runs, params: {"step":3,"history":["step-1-at-...","step-2-at-...","step-3-at-..."]}
  project-beta:  1 runs, params: {"step":1,"history":["step-1-at-..."]}
```

## Key Points

- Sessions are keyed by `(agentId, adapterType, taskKey)` — changing any of these starts a fresh session
- `sessionParams` from the previous run is passed as `ctx.runtime.sessionParams` to the next
- The mock adapter is a great starting point for writing your own custom adapter
