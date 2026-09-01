import type { Policy } from "../policy.ts"
import { APP_ALIASES, MANIFEST_READS } from "./shared.ts"

const DESKTOP = "packages/claxedo-desktop/src"
const APP = "packages/claxedo-app/src"

/**
 * The desktop is a COMPOSITION artifact, so its boundary is stated as three
 * closures rather than one: static main, lazy account, and renderer shell.
 *
 * Electron main and the renderer are separate processes with opposite rules,
 * and collapsing them into one policy is what makes a desktop boundary check
 * meaningless. Static main owns the Host Connector child supervisor (not its
 * implementation), the lazy account chunk owns OAuth credentials, and the
 * renderer sees neither.
 */

/**
 * The source walk deliberately sees string-literal dynamic imports, while the
 * emitted manifest cuts at `account/index.ts`. That pairing proves both that
 * the complete main composition is clean and that unsigned startup loads only
 * the lazy broker, not the credential-bearing account adapter.
 */
export const desktopMainComposition: Policy = {
  id: "desktop-main-composition",
  summary: "@claxedo/desktop Electron main base composition (src/main/index.ts)",
  packageDir: "packages/claxedo-desktop",
  entry: `${DESKTOP}/main/index.ts`,
  roots: [DESKTOP],
  forbiddenPackages: [
    "@clerk/clerk-js",
    "convex",
    "@claxedo/server",
    "@claxedo/workgraph",
    "@claxedo/local-server",
    "@claxedo/host-connector",
  ],
  forbiddenModules: [`${DESKTOP}/renderer`],
  control: {
    minModules: 55,
    requiredModules: [
      `${DESKTOP}/main/index.ts`,
      `${DESKTOP}/main/account/lazy-account.ts`,
      `${DESKTOP}/main/host-connector/electron-child.ts`,
      `${DESKTOP}/main/host-connector/child-supervisor.ts`,
      `${DESKTOP}/main/navigation-guard.ts`,
    ],
    requiredPackages: ["electron"],
  },
  // Renderer trust/readiness and native-rich-content supervision add nine
  // reviewed main-process modules. Durable local-server startup then adds the
  // daemon discovery and lease owners. The app-exit fix adds the canonical
  // daemon-exit lifecycle owner. Account identity resolution (`account/identity.ts`,
  // reached through the lazy account composition the source walk includes)
  // publishes display name/email after OAuth. Account IPC and service timing
  // share `account/account-perf.ts` as the single diagnostics owner. The
  // credential-bound auth descriptor and native refresh owner replace the old
  // userinfo identity module, a reviewed net +1 module with no package growth.
  // Control-plane transport resilience adds two reviewed owners:
  // `account/hosted-transport.ts` (stall recovery for hosted reads) and
  // `account/no-reuse-fetch.ts` (fresh-connection node http(s) fetch), the
  // latter bringing `node:https` and `node:stream` into the main closure.
  // Keep the measured closure exact with no headroom.
  // 2026-09-01: +1 `host-connector/child-protocol.ts` growth is internal; the
  // new module is the serving push path in `main/index.ts` reaching the
  // supervisor's onServing seam (machine-wide enrollment). 83/24.
  // `host-connector/account-follow.ts` is the one owner of what remote access
  // does when the account changes (verdicts, not reachability): one module.
  ceilings: { modules: 84, packages: 24 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-main.json",
    minModules: 35,
    minChunks: 3,
    requiredModules: [
      `${DESKTOP}/main/index.ts`,
      `${DESKTOP}/main/account/lazy-account.ts`,
      `${DESKTOP}/main/host-connector/electron-child.ts`,
      `${DESKTOP}/main/host-connector/child-supervisor.ts`,
    ],
  },
}

export const desktopAccountComposition: Policy = {
  id: "desktop-account-composition",
  summary: "@claxedo/desktop lazy Electron account composition (src/main/account/index.ts)",
  packageDir: "packages/claxedo-desktop",
  entry: `${DESKTOP}/main/account/index.ts`,
  roots: [DESKTOP],

  forbiddenPackages: [
    // The browser identity SDK. Main authenticates through its own OAuth/PKCE
    // flow in `src/main/account/oauth-flow.ts`, which speaks HTTP.
    "@clerk/clerk-js",
    "convex",
    // The hosted control plane. Main starts a LOCAL server child process; a
    // hosted server package in this graph is the split leaking backwards.
    "@claxedo/server",
    "@claxedo/workgraph",
    // Main composes the local server as a separate child process
    // (`scripts/claxedo-server-entry.ts`), never in-process.
    "@claxedo/local-server",
    "@claxedo/host-connector",
  ],
  forbiddenModules: [
    // The renderer is a different process with a different module system.
    // A main-process import of renderer source would bundle DOM code into Node.
    `${DESKTOP}/renderer`,
    `${DESKTOP}/main/host-connector`,
  ],

  control: {
    minModules: 10,
    requiredModules: [
      `${DESKTOP}/main/account/index.ts`,
      `${DESKTOP}/main/account/hosted-operations.ts`,
      `${DESKTOP}/main/account/credential-store.ts`,
    ],
    requiredPackages: ["electron"],
  },

  // Control-plane transport resilience: `account/no-reuse-fetch.ts` (reviewed
  // owner of the fresh-connection node http(s) fetch) joins through
  // `account/index.ts`, adding `node:https` to the composition closure.
  // 2026-09-01: +1 — the account composition now reaches the host-connector
  // protocol's shared types through the supervisor's assignment ops
  // (workspace.assignHost via runAccountOperation). 17/7.
  ceilings: { modules: 17, packages: 7 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-account.json",
    minModules: 10,
    minChunks: 1,
    requiredModules: [
      `${DESKTOP}/main/account/index.ts`,
      `${DESKTOP}/main/account/hosted-operations.ts`,
      `${DESKTOP}/main/account/credential-store.ts`,
    ],
  },
}

/**
 * The UNSIGNED desktop renderer.
 *
 * `local.tsx` is the only renderer entry. Hosted contributions are reached
 * through a dynamic import after Electron reports signed account state; the
 * emitted manifest below follows only the base entry's static chunk graph.
 *
 * This crosses INTO `@claxedo/app` on purpose. The desktop renderer composes
 * that package's shared shell, so "what does the unsigned desktop reach" is
 * unanswerable without following the edge — and the one specifier that matters,
 * `@claxedo/app/auth`, resolves through the app's `exports` map to
 * `src/app/entry/auth.ts` rather than to `src/auth.ts`. A walk that cannot make
 * that hop reports a clean desktop closure and is wrong; it is exactly how the
 * desktop shipped Clerk to every unsigned launch while the app's own local
 * guard stayed green.
 *
 * The source closure deliberately includes the dynamic hosted contribution so
 * it can reject a Clerk/Convex leak anywhere in the shipped renderer graph.
 * The emitted manifest is the narrower unsigned-startup proof: it cuts at the
 * optional chunk while retaining the dynamic edge as build metadata.
 */
export const desktopRendererUnsigned: Policy = {
  id: "desktop-renderer-unsigned",
  summary: "@claxedo/desktop unsigned renderer entry (src/renderer/local.tsx)",
  packageDir: "packages/claxedo-desktop",
  entry: `${DESKTOP}/renderer/local.tsx`,
  roots: [DESKTOP, APP],
  aliases: APP_ALIASES,
  followed: [{ name: "@claxedo/app", dir: "packages/claxedo-app" }],

  forbiddenPackages: ["@clerk/clerk-js", "convex", "@claxedo/host-connector", "electron"],
  forbiddenModules: [
    // The app's authenticated-identity module and the subpath that reaches it.
    `${APP}/platform/auth/auth-client.ts`,
    `${APP}/app/entry/auth.ts`,
    // The app's hosted browser entry.
    `${APP}/app/entry/main.tsx`,
    // Electron main is a different process. A renderer import of `src/main/**`
    // would put the machine private key and the OAuth client secret handling
    // in the window.
    `${DESKTOP}/main/account`,
    `${DESKTOP}/main/host-connector`,
    // The signed renderer entry, which imports `@claxedo/app/auth`.
    `${DESKTOP}/renderer/index.tsx`,
  ],
  permittedOutsideRoots: MANIFEST_READS,
  permittedOpaqueImports: [`${APP}/platform/extensions/user-extensions.ts -> import(url)`],

  control: {
    minModules: 700,
    requiredModules: [
      `${DESKTOP}/renderer/local.tsx`,
      `${DESKTOP}/renderer/shell.tsx`,
      // Reached only by crossing the package boundary. Its absence means the
      // walk never left `claxedo-desktop` — which is the state in which every
      // "no Clerk" answer below is worthless.
      `${APP}/app/entry/app.tsx`,
      // Reached only through the `@/` alias from a DESKTOP file
      // (`renderer/shell.tsx` imports `@/platform/api/api`).
      `${APP}/platform/api/api.ts`,
    ],
    requiredPackages: ["solid-js", "@claxedo/workgraph"],
  },

  // The session-switch architecture splits twenty-five narrow owners out of
  // already reachable app modules (route/title/pane projections, bounded
  // prefetch, first-fold/history hydration, progressive release, memory and
  // files/runtime state); removing the old Markdown preloader offsets one.
  // Because the desktop follows the local app entry, its reviewed closure is
  // therefore 921 + 24 = 945 modules with no new package edge.
  //
  // The workspace-panel/review performance campaign then splits its own
  // narrow owners out of the same reachable surface: the review window's
  // height projection and diff prime, the panel shell's settle fact and body
  // hydration door, the timeline's displayed-frame loop, the file viewer's
  // content-backed find, the runtime file-request cache, and the navigator's
  // hover prefetch, plus the session-ui splits those lean on. The subsequent
  // virtualized-review validation replaces one owner with separate toggle and
  // loaded-identity owners, a net increase of one. Reviewed closure is
  // therefore 945 + 30 = 975 modules. The discovery-driven ACP picker adds
  // one canonical connection-catalog owner to that already reachable
  // composer path, bringing the reviewed closure to 976 modules. Subsequent
  // navigation, runtime ownership, keyboard hint, branch-source, and terminal
  // status work adds eight named owners while removing four obsolete owners,
  // bringing the reviewed closure to 980 modules with no new package edge.
  // Durable archive cleanup adds its canonical projection-cancellation owner.
  // Session markdown / settings owners (981 + 8 = 989) plus tenant-aware
  // multiplayer's four local owners (989 + 4 = 993). Org→Team product UI adds
  // the same six local app owners as app-local: 993 + 6 = 999.
  // Cloud workspace create / AccountPort bridge / adapters follow app-local:
  // 999 + 1 (workspace-create-api) + 1 (hosted-control-call) + 3 (integrations/
  // documents/WorkGraph) + 1 (control-plane fetch) + 1 (SSE stream) + 1
  // (agent-config extensions) = 1007. The 16 lazy provider-settings locale
  // dictionaries shared with app-local bring this to 1023. The reviewed
  // deployable-service split adds the service contribution catalog, Documents
  // and WorkGraph contribution roots, bootstrap-owner route, and canonical
  // private-session reservation client while retiring the monolithic hosted
  // contribution loader: net +5 modules. `@claxedo/service-contract` is the
  // one dependency-neutral package addition. Exact closure: 1028/59.
  // 2026-09-01: +2 `app/shell-revealed.ts` (the one window-once splash flag
  // both shell boundaries consult) and the unshare path through
  // `platform/remote-access` (machine-wide enrollment share toggle). 1030/59.
  // 2026-09-01: +1 `features/workspaces/data/auto-share-local-workspaces.ts`,
  // the same reconciler app-local took. Enabling remote access on the desktop
  // now publishes every local workspace the machine holds rather than the ones
  // a user ticked, and this is the module that keeps the two sets equal.
  // Reviewed owner: the workspaces data domain (see app-local.ts). 1031/59.
  // Session open/switch instrumentation (`platform/performance/session-perf.ts`
  // and its screen-side owner `features/session/ui/session-open-perf.ts`)
  // adds two modules and no package edge: 1033/59.
  ceilings: { modules: 1033, packages: 59 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-local.json",
    minModules: 700,
    minChunks: 1,
    requiredModules: [
      `${DESKTOP}/renderer/local.tsx`,
      `${DESKTOP}/renderer/shell.tsx`,
      `${APP}/app/entry/app.tsx`,
    ],
    forbiddenModules: [
      `${DESKTOP}/renderer/hosted-contributions.ts`,
      `${APP}/app/composition/hosted-contribution-loader.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access-binding.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access.ts`,
    ],
    forbiddenChunkMarkers: ["desktop-hosted-contributions"],
  },
}

/** Optional renderer subtree activated only through Electron's AccountPort. */
export const desktopHostedContribution: Policy = {
  id: "desktop-hosted-contribution",
  summary: "@claxedo/desktop optional hosted contribution (src/renderer/hosted-contributions.ts)",
  packageDir: "packages/claxedo-desktop",
  entry: `${DESKTOP}/renderer/hosted-contributions.ts`,
  roots: [DESKTOP, APP],
  aliases: APP_ALIASES,
  followed: [{ name: "@claxedo/app", dir: "packages/claxedo-app" }],
  forbiddenPackages: ["@clerk/clerk-js", "convex", "@claxedo/host-connector", "electron"],
  forbiddenModules: [
    `${APP}/platform/auth/auth-client.ts`,
    `${APP}/app/entry/auth.ts`,
    `${APP}/app/entry/main.tsx`,
    `${DESKTOP}/main`,
  ],
  permittedOutsideRoots: MANIFEST_READS,
  permittedOpaqueImports: [`${APP}/platform/extensions/user-extensions.ts -> import(url)`],
  control: {
    minModules: 4,
    requiredModules: [
      `${DESKTOP}/renderer/hosted-contributions.ts`,
      `${APP}/platform/remote-access/machine-remote-access.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access-binding.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access.ts`,
    ],
    requiredPackages: [],
  },
  // Optional service renderers now have independent catalog-driven roots. This
  // activation entry owns only desktop machine remote access and its shared
  // contract, so the reviewed closure deliberately shrinks from 322/40 to 4/0.
  ceilings: { modules: 4, packages: 0 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-hosted-contributions.json",
    minModules: 4,
    minChunks: 1,
    requiredModules: [
      `${DESKTOP}/renderer/hosted-contributions.ts`,
      `${APP}/platform/remote-access/machine-remote-access.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access-binding.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access.ts`,
    ],
  },
}
