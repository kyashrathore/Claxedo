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
 *    anonymous auth-session abstraction, and login route. Those files stay
 *    co-located in this package; forbidding their whole roots here would fail
 *    on real code rather than gate anything. The exact ceiling keeps that
 *    seam shrinking.
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
      // Owns the loopback-vs-hosted route split without importing relay or
      // hosted workspace machinery into the local product closure.
      `${SRC}/platform/runtime/server-transport.ts`,
      // Reached only through `#terminal-backend`, the build-config virtual
      // module. Same reasoning, different resolver.
      `${SRC}/features/terminal/core/backend/xterm.ts`,
    ],
    requiredPackages: ["solid-js", "@claxedo/workgraph"],
  },

  // Measured 2026-08-09 with `runtimeOnly`, after the hosted loader moved to
  // the hosted entry, plus the dependency-light loopback transport owner.
  // No headroom: the remaining shared seam must only shrink.
  // Usage adds the chart, breakdown, quota view, and shared provider-brand
  // module to the local UI; all other dependencies were already in the
  // renderer closure.
  // Five reviewed local owners entered after the 2026-08 local-entry
  // baseline: live-session/project ownership, rail status, first-fold prefetch, and the
  // deferred message navigator. The session-switch performance campaign adds
  // another twenty-five narrow owners for reactive route snapshots, title and
  // pane projection, memory accounting, bounded prefetch, first-fold/history
  // hydration, progressive reveal, secondary status, files, and runtime URLs.
  // Removing the speculative Markdown preloader offsets one, so the complete
  // reviewed closure grows from 831 to 860 modules and adds no package edge.
  // The workspace-panel/review performance campaign splits twenty-nine more
  // narrow owners out of the same reachable surface (review window height
  // projection and diff prime, panel settle fact and body-hydration door,
  // timeline displayed-frame loop, content-backed file find, runtime
  // file-request cache, navigator hover prefetch, and the session-ui splits
  // those lean on). The subsequent virtualized-review validation replaces the
  // old open-diffs owner with separate toggle and loaded-identity owners, a net
  // increase of one. The session-navigation row's directly imported style
  // sheet is also a source-walk module: 860 + 30 + 1 = 891 modules, still no
  // package edge. The reviewed session/workbench follow-ups add eight focused
  // owners for app-shell navigation, UI flags, rail shortcuts, base branches,
  // parent navigation, terminal status, workspace routes, and project owners,
  // while retiring three AI-connect modules: 891 + 8 - 3 = 896 modules, with
  // no package-ceiling change. The ordered session-archive projection boundary
  // adds one local session owner: 896 + 1 = 897 modules, still no package edge.
  // Session markdown first-fold preload, environment-card persistence, Thinking
  // visibility hold, provider-settings detect/disconnect logic, models-settings
  // logic, provider setup row, and the settings-providers dialog opener add
  // eight named owners (897 + 8 = 905). Tenant-aware multiplayer adds four
  // already-reachable local owners: 905 + 4 = 909. Org→Team product UI adds six
  // local owners (settings org-team section + API, session share API + Share
  // control, rail org/team switcher): 909 + 6 = 915 modules.
  // Cloud workspace create routes through AccountPort via workspace-create-api:
  // 915 + 1 = 916. Shared AccountPort bridge (`hosted-control-call`) plus
  // connection mint/refresh and workspace.resolve: 916 + 1 = 917.
  // Integrations, documents, and WorkGraph AccountPort adapters: 917 + 3 = 920.
  // Control-plane AccountPort fetch adapter: 920 + 1 = 921.
  // AccountPort SSE stream adapter (`account-stream-fetch`): 921 + 1 = 922.
  // Agent-config extensions AccountPort adapter (marketplace): 922 + 1 = 923
  // modules. Provider-settings translations are split into one lazy feature
  // dictionary per non-English locale: 923 + 16 = 939. The reviewed auth and
  // Cloudflare-deployable flow adds the service-contribution catalog,
  // bootstrap-owner route, and canonical private-session reservation client.
  // `@claxedo/service-contract` is their dependency-neutral vocabulary owner.
  // 2026-09-01: +2 `workspace/user-hosted-serving.ts` + its loopback control
  // routes — the machine's ONE relay serving connection under machine-wide
  // enrollment (reviewed owner: local-server workspace domain).
  // 2026-09-01: +1 `features/workspaces/data/auto-share-local-workspaces.ts`.
  // Remote access is machine level, so the published set is reconciled against
  // this machine's local workspace inventory instead of a per-workspace tick
  // list; reviewed owner is the workspaces data domain, which already owns both
  // halves (`share-workspace` decides what is local, `shared-workspaces` reads
  // what is published) and is the only layer allowed to import them —
  // `features/onboarding` may not.
  // Session open/switch instrumentation (`platform/performance/session-perf.ts`
  // and its screen-side owner `features/session/ui/session-open-perf.ts`)
  // adds two modules and no package edge.
  // `platform/runtime/agent/cached-signed-workspace.ts` — the one reader of the
  // signed inventory from the shared Query cache: one module, no package edge.
  // Removing the retired local UI extension view, registry, and loader
  // subtracts three modules.
  // The Goal-mode merge re-lands the universal-Goal session owners on top of
  // the local/cloud split: composer Goal intent/submission/draft lifecycle,
  // Goal authority cache/query/controller, runtime Goal client/event ingress,
  // the active-Goal dock, and the review-pass Stop fallback + shared JSON
  // reader: thirteen modules.
  ceilings: { modules: 957, packages: 38 },

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
