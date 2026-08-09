import type { Policy } from "../policy.ts"
import { APP_ALIASES, MANIFEST_READS } from "./shared.ts"

const SRC = "packages/claxedo-app/src"

/**
 * `@claxedo/app`'s LOCAL production entry.
 *
 * The local product exists so an unsigned desktop does not ship an identity
 * provider it can never use. The rules below are the same ones
 * `src/architecture/local-entry-closure.guard.test.ts` and
 * `vite.local.config.ts` state — this is the copy a reviewer runs with one
 * command, and the copy the other product policies are checked against.
 *
 * WHAT THIS DOES NOT COVER, stated because a green run here is otherwise easy
 * to over-read:
 *
 *  - It is a SOURCE walk. Rollup can put a module in a chunk with no import
 *    edge to follow — that is precisely how a `vendor-clerk` chunk reached a
 *    build whose whole purpose was to have no identity provider in it. The
 *    emitted half is `scripts/check-local-bundle-identity.ts`, which
 *    `verify:closure` runs after a real `build:local`.
 *  - The hosted IMPLEMENTATION SET is forbidden and absent, including its
 *    WorkGraph/Documents renderer chunk. A small shared contract/data seam is
 *    still reachable today: two modules under `features/workgraph/`, seven
 *    under `features/documents/`, the unbound cloud workspace port module,
 *    anonymous auth-session abstraction, and login route. Unit 10 was to move
 *    those remaining hosted contracts into `@claxedo/cloud-app` and is
 *    DEFERRED, so forbidding their whole roots here would fail on real code
 *    rather than gate anything. The exact ceiling keeps that seam shrinking.
 *
 * What IS enforced is the part that was actually finished: no identity
 * provider, no Convex, and no module route to `auth-client.ts` — the four
 * routes that existed on 2026-08-09 were each cut to a port.
 */
export const appLocal: Policy = {
  id: "app-local",
  summary: "@claxedo/app local entry (src/app/entry/local.tsx)",
  packageDir: "packages/claxedo-app",
  entry: `${SRC}/app/entry/local.tsx`,
  roots: [SRC],
  aliases: APP_ALIASES,

  forbiddenPackages: ["@clerk/clerk-js", "convex"],
  forbiddenModules: [
    // The module that MINTS a token. Every local module that needs one takes
    // it from `configureApiRuntime`/`configureAuthSession` instead.
    `${SRC}/platform/auth/auth-client.ts`,
    // The hosted browser entry. A local build reaching it would start Clerk.
    `${SRC}/app/entry/main.tsx`,
    // The hosted implementation set. Its loader is injected by main.tsx, so a
    // local build must not carry even its lazy chunk.
    `${SRC}/app/integrations/hosted-content-surfaces.tsx`,
  ],
  permittedOutsideRoots: MANIFEST_READS,

  control: {
    // The local entry is the whole shared app shell; a walk that read only the
    // entry file would report 1.
    minModules: 700,
    requiredModules: [
      `${SRC}/app/entry/local.tsx`,
      // The shared shell. Absent means the walk stopped at the entry.
      `${SRC}/app/entry/app.tsx`,
      // Reached only through the `@/` alias, so its absence means alias
      // resolution silently died — the failure that would ALSO hide the
      // identity provider and report a clean local product.
      `${SRC}/platform/api/api.ts`,
      // Reached only through `#terminal-backend`, the build-config virtual
      // module. Same reasoning, different resolver.
      `${SRC}/features/terminal/core/backend/xterm.ts`,
    ],
    requiredPackages: ["solid-js", "@claxedo/workgraph"],
  },

  // Measured 2026-08-09 with `runtimeOnly`, after the hosted loader moved to
  // the hosted entry. No headroom: the remaining shared seam must only shrink.
  ceilings: { modules: 808, packages: 41 },

  emitted: {
    file: "packages/claxedo-app/.artifacts/u8-package-split/manifests/app-local.json",
    // Positive controls measured from the real Vite build. Deliberately loose
    // enough for dependency pruning, but far above an empty/partial manifest.
    minModules: 2_000,
    minChunks: 300,
    requiredModules: [
      `${SRC}/app/entry/local.tsx`,
      `${SRC}/app/entry/app.tsx`,
      `${SRC}/features/terminal/core/backend/xterm.ts`,
    ],
    forbiddenChunkMarkers: ["clerk", "convex", "hosted-content-surfaces"],
  },
}
