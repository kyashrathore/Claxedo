import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-local-server/src"

/**
 * The desktop-local server, from the entry the desktop actually starts.
 *
 * `claxedo-desktop/scripts/claxedo-server-entry.ts` imports exactly one thing —
 * `@claxedo/local-server/self-hosted-execution` — and that import is the
 * unsigned desktop's entire server-side closure. So that subpath is the entry
 * here, rather than the package's whole `exports` surface: the package-wide
 * walk is `src/architecture/local-closure.test.ts`'s job and answers "what may
 * a consumer import", while this answers "what does the shipped product load".
 * Both are run by `verify:closure`.
 *
 * The forbidden list is the same one that test states, and for the same reason:
 * each entry is a hosted capability an unsigned desktop has no way to use and
 * no business carrying. When this measurement started, the desktop-local entry
 * reached 259 first-party modules and 42 packages — Convex, better-auth,
 * WorkGraph, channels, connections, wakes — from a build that never signs in.
 */
export const localServer: Policy = {
  id: "local-server",
  summary: "@claxedo/local-server desktop entry (src/self-hosted-execution.ts)",
  packageDir: "packages/claxedo-local-server",
  entry: `${SRC}/self-hosted-execution.ts`,
  roots: [SRC],

  forbiddenPackages: [
    "@claxedo/sandbox-manager",
    "@claxedo/server",
    "@claxedo/workgraph",
    "@claxedo/channels",
    "@claxedo/connections",
    "@claxedo/wakes",
    "convex",
    "better-auth",
    "posthog-node",
    // Not in the package-wide list, and it belongs here: the desktop server is
    // a child process of Electron, not the renderer, and a UI package in this
    // graph would mean the split leaked in the other direction.
    "@claxedo/app",
    "@clerk/clerk-js",
  ],
  forbiddenModules: [
    "packages/claxedo-server/src",
    "packages/claxedo-app/src",
    "packages/sandbox-manager/src",
    "packages/workgraph/src",
    "packages/claxedo-channels/src",
    "packages/claxedo-connections/src",
    "packages/wakes/src",
  ],

  control: {
    minModules: 30,
    requiredModules: [
      `${SRC}/self-hosted-execution.ts`,
      // The composition this entry exists to start. Absent means the walk
      // stopped at the re-export.
      `${SRC}/app/start-local-server.ts`,
      `${SRC}/app/local-app.ts`,
      `${SRC}/workspace/routes/resolve-route.ts`,
    ],
    // The embedded runtime and the HTTP framework. A walk that read no imports
    // reports neither.
    requiredPackages: ["@claxedo/workspace-runtime", "hono"],
  },

  // Measured 2026-08-09 with `runtimeOnly`. The eight added modules are the
  // complete local usage pipeline (route, durable ports, scanner, pricing
  // port, outbox, host identity, and composition). Shared implementation lives
  // in server-core, so the desktop still reaches no hosted capability package.
  // Tenant-aware sandbox fetch options are a local workspace owner with no
  // hosted capability package: 56 + 1 = 57 modules.
  // 2026-08-29: +1 `embedded-relay-host-auth.ts` — verified actor hop stamp for
  // in-process embedded prompts (`claxedo.author` without managed authority).
  // Removing the retired local user-extension route subtracts one module.
  ceilings: { modules: 57, packages: 21 },

  emitted: {
    file: "packages/claxedo-local-server/.artifacts/u8-package-split/manifests/local-server.json",
    minModules: 500,
    minChunks: 1,
    requiredModules: [
      // The facade is all re-exports and therefore has no generated range in
      // Bun's source map. `entry` above still pins it; these prove its bodies.
      `${SRC}/app/start-local-server.ts`,
      `${SRC}/app/local-app.ts`,
      "packages/claxedo-server-core/src/platform/db/db.ts",
    ],
  },

  isolation: {
    native: ["node-pty", "better-sqlite3"],
    // These packages publish dist-only exports. Build them in dependency order
    // inside the isolated workspace so the Local Server bundle never consumes
    // outputs left behind by a developer's existing checkout.
    buildPackages: [
      { packageDir: "packages/agent-event-runtime" },
      { packageDir: "packages/agent-extensions" },
      { packageDir: "packages/agent-sdk-runtime" },
      { packageDir: "packages/workspace-relay-protocol" },
      { packageDir: "packages/workspace-relay" },
      { packageDir: "packages/workspace-runtime" },
    ],
    commands: [["bun", "run", "build"], ["bun", "run", "smoke:build"]],
  },
}
