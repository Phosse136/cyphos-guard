import { configDefaults, defineConfig } from "vitest/config";

// Fork integration tests (*.fork.test.ts) need anvil and network access: run them with `pnpm test:fork`.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/*.fork.test.ts", "packages/contracts/lib/**"] },
});
