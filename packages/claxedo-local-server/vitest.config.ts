import { configDefaults, defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: [
      // The runtime is reached from several packages; aliasing it to SOURCE
      // keeps one copy in the module graph and exercises the code a change
      // touches rather than a dist that may lag it.
      { find: "@claxedo/workspace-runtime/config", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/config.ts") },
      { find: "@claxedo/workspace-runtime/exposure", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/exposure.ts") },
      { find: "@claxedo/workspace-runtime/host", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/host.ts") },
      { find: "@claxedo/workspace-runtime/relay", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/relay.ts") },
      { find: "@claxedo/workspace-runtime/routes", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/routes.ts") },
      { find: "@claxedo/workspace-runtime/http", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/http.ts") },
      { find: "@claxedo/workspace-runtime/route-contribution", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/route-contribution.ts") },
      { find: "@claxedo/workspace-runtime", replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/index.ts") },
    ],
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    exclude: [...configDefaults.exclude],
  },
})
