import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.fork.test.ts"],
    exclude: ["**/node_modules/**", "packages/contracts/lib/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
