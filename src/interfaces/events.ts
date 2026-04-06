import type { Run, AdapterExecutionResult } from "../types.js";

export interface OrchestratorEventMap {
  "run.queued": [run: Run];
  "run.started": [run: Run];
  "run.completed": [run: Run, result: AdapterExecutionResult];
  "run.failed": [run: Run, error: Error];
  "run.cancelled": [run: Run];
  "session.rotated": [agentId: string, taskKey: string, reason: string];
  "agent.status": [agentId: string, status: string];
}

export type OrchestratorEventName = keyof OrchestratorEventMap;

/**
 * Typed event emitter for orchestrator lifecycle events.
 */
export interface OrchestratorEventEmitter {
  on<E extends OrchestratorEventName>(
    event: E,
    listener: (...args: OrchestratorEventMap[E]) => void,
  ): void;
  off<E extends OrchestratorEventName>(
    event: E,
    listener: (...args: OrchestratorEventMap[E]) => void,
  ): void;
  emit<E extends OrchestratorEventName>(
    event: E,
    ...args: OrchestratorEventMap[E]
  ): void;
}
