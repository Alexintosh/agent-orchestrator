import { claudeLocalAdapter } from "./claude-local/index.js";
import { codexLocalAdapter } from "./codex-local/index.js";
import { cursorLocalAdapter } from "./cursor-local/index.js";
import { geminiLocalAdapter } from "./gemini-local/index.js";
import { opencodeLocalAdapter } from "./opencode-local/index.js";
import { piLocalAdapter } from "./pi-local/index.js";
import { openclawGatewayAdapter } from "./openclaw-gateway/index.js";

/**
 * All bundled adapter modules, keyed by their type string.
 *
 * @example
 * ```ts
 * import { adapters } from 'agent-orchestrator';
 * const orchestrator = createOrchestrator({
 *   adapters: Object.values(adapters),
 * });
 * ```
 */
export const adapters = {
  claudeLocal: claudeLocalAdapter,
  codexLocal: codexLocalAdapter,
  cursorLocal: cursorLocalAdapter,
  geminiLocal: geminiLocalAdapter,
  opencodeLocal: opencodeLocalAdapter,
  piLocal: piLocalAdapter,
  openclawGateway: openclawGatewayAdapter,
} as const;
