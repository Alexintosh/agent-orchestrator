import type {
  OrchestratorEventEmitter,
  OrchestratorEventMap,
  OrchestratorEventName,
} from "./interfaces/events.js";

/**
 * Simple typed event emitter for orchestrator lifecycle events.
 */
export class EventEmitter implements OrchestratorEventEmitter {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on<E extends OrchestratorEventName>(
    event: E,
    listener: (...args: OrchestratorEventMap[E]) => void,
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as (...args: unknown[]) => void);
  }

  off<E extends OrchestratorEventName>(
    event: E,
    listener: (...args: OrchestratorEventMap[E]) => void,
  ): void {
    this.listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
  }

  emit<E extends OrchestratorEventName>(
    event: E,
    ...args: OrchestratorEventMap[E]
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch {
        // Swallow listener errors to prevent breaking the emitter
      }
    }
  }
}
