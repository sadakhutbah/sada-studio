import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same aliases as the renderer build, so that renderer modules can be tested.
  resolve: { alias: { "@core": resolve("src/core"), "@shared": resolve("src/shared") } },
  test: { include: ["tests/**/*.test.ts"], environment: "node", setupFiles: ["tests/setup.ts"] },
});
