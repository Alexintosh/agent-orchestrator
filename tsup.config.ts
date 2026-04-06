import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/claude-local/index.ts",
    "src/adapters/codex-local/index.ts",
    "src/adapters/cursor-local/index.ts",
    "src/adapters/gemini-local/index.ts",
    "src/adapters/opencode-local/index.ts",
    "src/adapters/pi-local/index.ts",
    "src/adapters/openclaw-gateway/index.ts",
    "src/stores/memory.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: true,
});
