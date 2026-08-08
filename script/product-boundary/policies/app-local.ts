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
 *  - Hosted CAPABILITIES are still reachable and are NOT forbidden here, because
 *    they genuinely are in the graph today: 29 modules under `features/workgraph/`,
 *    29 under `features/documents/`, `platform/runtime/cloud/workspace-runtime-store.ts`,
 *    `platform/auth/auth-session.ts`, and the two login routes, all through the
 *    shared shell `app/entry/app.tsx`. Unit 10 was to move them into
 *    `@claxedo/cloud-app` and is DEFERRED, so forbidding them here would fail
 *    on real code rather than gate anything. The module ceiling is what keeps
 *    that set from quietly growing in the meantime.
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

  // Measured 2026-08-09 with `runtimeOnly`. No headroom on purpose: a ceiling
  // with slack lets a closure grow by a fifth without anyone reading it.
  ceilings: { modules: 861, packages: 63 },
}
