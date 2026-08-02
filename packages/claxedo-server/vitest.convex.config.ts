import { defineConfig } from "vitest/config"
import path from "node:path"

/**
 * Runner for the repo-root `convex/` backend functions.
 *
 * Those 42 modules have no package.json and the repo root refuses to run tests,
 * so their policy suite had been parked inside claxedo-server/src — importing
 * across five directory levels and driving a hand-written `db` double that
 * bypassed the auth wrappers it was supposed to be testing. Convex's guidance
 * is that function tests live in `convex/` as `*.test.ts` and go through
 * `convex-test`: https://docs.convex.dev/testing/convex-test
 *
 * The config lives HERE rather than in `convex/` because `convex/` is not a
 * workspace member and cannot resolve `vitest` on its own; this package owns
 * both `vitest` and `convex-test`. `root` points the runner at the convex tree.
 *
 * `environment: "edge-runtime"` (@edge-runtime/vm) is the documented setting —
 * it matches the Convex runtime more closely than node, so a Node-only builtin
 * fails here rather than passing locally and breaking on deploy.
 * `server.deps.inline` is required so convex-test runs inside the edge VM.
 *
 * convex-test still MOCKS the runtime: no cron support (trigger scheduled
 * functions by hand), simplified text/vector search, non-production ID formats.
 */
const packageModules = path.resolve(import.meta.dirname, "node_modules")

export default defineConfig({
  root: path.resolve(import.meta.dirname, "../../convex"),
  // `convex/` is outside this package, so Vite resolves bare specifiers from
  // the convex root and cannot see this package's node_modules. Point the two
  // test-only deps at it explicitly.
  resolve: {
    alias: {
      "convex-test": path.join(packageModules, "convex-test"),
      convex: path.join(packageModules, "convex"),
    },
  },
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["**/*.test.ts"],
    testTimeout: 30_000,
  },
})
