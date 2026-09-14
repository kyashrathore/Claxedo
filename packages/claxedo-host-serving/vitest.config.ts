import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // Workspace packages export `development` -> src/*.ts ahead of `import` ->
    // dist/*.mjs. Resolving that condition, as tsconfig.json does, exercises
    // the source a change touches and needs no sibling build.
    conditions: ["development"],
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    exclude: [...configDefaults.exclude],
  },
})
