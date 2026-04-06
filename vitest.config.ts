import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/adapters-bundle.test.ts"],
    testTimeout: 30_000,
    teardownTimeout: 5_000,
  },
});
