import { configDefaults, defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@claxedo\/session-core\/access-policy$/, replacement: path.resolve(import.meta.dirname, "../session-core/src/session-access-policy.ts") },
      { find: /^@claxedo\/session-core\/testing$/, replacement: path.resolve(import.meta.dirname, "../session-core/src/testing.ts") },
      { find: /^@claxedo\/session-core$/, replacement: path.resolve(import.meta.dirname, "../session-core/src/index.ts") },
      { find: /^@claxedo\/harness\/opencode-sdk\/(.+)$/, replacement: path.resolve(import.meta.dirname, "../harness/src/transports/opencode-sdk/$1.ts") },
      { find: /^@claxedo\/harness\/opencode-sdk$/, replacement: path.resolve(import.meta.dirname, "../harness/src/transports/opencode-sdk/index.ts") },
      { find: /^@claxedo\/workspace-runtime\/config$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/config.ts") },
      { find: /^@claxedo\/workspace-runtime\/exposure$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/exposure.ts") },
      { find: /^@claxedo\/workspace-runtime\/host$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/host.ts") },
      { find: /^@claxedo\/workspace-runtime\/relay$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/relay.ts") },
      { find: /^@claxedo\/workspace-runtime\/routes$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/routes.ts") },
      // Aliased alongside the rest so a test exercises the runtime SOURCE, not
      // a dist that may lag it. Without the alias a consumer resolving through
      // its own dist would pull a second copy of the runtime into the module
      // graph.
      { find: /^@claxedo\/workspace-runtime\/client$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/client.ts") },
      { find: /^@claxedo\/workspace-runtime\/route-contribution$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/route-contribution.ts") },
      { find: /^@claxedo\/workspace-runtime$/, replacement: path.resolve(import.meta.dirname, "../workspace-runtime/src/index.ts") },
    ],
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    setupFiles: ["./src/test-support/data-isolation.ts"],
    // The Worker's suite runs under its own package script, so its security
    // tests do not depend on this glob reaching a scripts directory.
    exclude: [
      ...configDefaults.exclude,
      "scripts/sandbox/cloudflare-worker/**",
    ],
  },
})
