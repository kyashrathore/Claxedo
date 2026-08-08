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
  forbiddenModules: [],

  control: {
    minModules: 30,
    requiredModules: [
      `${SRC}/self-hosted-execution.ts`,
      // The composition this entry exists to start. Absent means the walk
      // stopped at the re-export.
      `${SRC}/app/start-local-server.ts`,
      `${SRC}/app/local-app.ts`,
    ],
    // The embedded runtime and the HTTP framework. A walk that read no imports
    // reports neither.
    requiredPackages: ["@claxedo/workspace-runtime", "hono"],
  },

  // Measured 2026-08-09 with `runtimeOnly`. Identical to the module count
  // `local-closure.test.ts` records for the package's whole published surface,
  // which is the honest reading: every published module is reachable from this
  // entry, so the desktop server IS the package.
  ceilings: { modules: 47, packages: 21 },
}
