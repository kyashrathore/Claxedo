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
