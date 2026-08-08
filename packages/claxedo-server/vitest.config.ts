import { configDefaults, defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@claxedo/workspace-runtime/config": path.resolve(import.meta.dirname, "../workspace-runtime/src/config.ts"),
      "@claxedo/workspace-runtime/exposure": path.resolve(import.meta.dirname, "../workspace-runtime/src/exposure.ts"),
      "@claxedo/workspace-runtime/host": path.resolve(import.meta.dirname, "../workspace-runtime/src/host.ts"),
      "@claxedo/workspace-runtime/relay": path.resolve(import.meta.dirname, "../workspace-runtime/src/relay.ts"),
      "@claxedo/workspace-runtime/routes": path.resolve(import.meta.dirname, "../workspace-runtime/src/routes.ts"),
      // Aliased alongside the rest so a test exercises the runtime SOURCE, not
      // a dist that may lag it. Both are reached from `@claxedo/workgraph`'s
      // runtime adapter, which resolves through its own dist and would
      // otherwise pull a second copy of the runtime into the module graph.
      "@claxedo/workspace-runtime/http": path.resolve(import.meta.dirname, "../workspace-runtime/src/http.ts"),
      "@claxedo/workspace-runtime/route-contribution": path.resolve(
        import.meta.dirname,
        "../workspace-runtime/src/route-contribution.ts",
      ),
      "@claxedo/workspace-runtime": path.resolve(import.meta.dirname, "../workspace-runtime/src/index.ts"),
    },
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    exclude: [
      ...configDefaults.exclude,
      "scripts/sandbox/cloudflare-worker/.sandbox-build/**",
    ],
  },
})
