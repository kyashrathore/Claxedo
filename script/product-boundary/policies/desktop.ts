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
    "@claxedo/server",
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
  // `host-connector/local-workspace-description.ts` — the machine's own description
  // of a shared workspace, read from the daemon at share time: one module.
  // +2 `main/dev-identity.ts` and its electron-free policy half
  // `main/dev-identity-policy.ts` — the one owner of a linked worktree's
  // per-instance app name, icon tint and userData suffix, reached from
  // `main/index.ts` and `main/windows.ts`. Electron and node:fs/path only, so
  // no package edge: 87/24.
  // +1 `main/agent-plugins-signed-sync.ts` — the one owner of how the daemon's
  // signed Agent Plugins world follows the account: main pulls the signed
  // user's runtime with the credential only it holds and hands it to the
  // daemon's loopback surface. Reached from `main/index.ts`; timers and fetch
  // only, so no package edge: 88/24.
  // +2 modules / -1 package (2026-09-06, oxlint type-aware sweep). Two reviewed
  // owners in `shared/`, both reached at depth 1-2 from `main/index.ts`:
  // `shared/node-error.ts` (the one narrowing of an unknown catch to a node
  // errno, via `shared/compile-cache.ts`) and `shared/json-read.ts` (read + parse
  // + shape-check, which is where `main/browser/json-read.ts` moved to when the
  // account composition needed the same thing — that module is gone, so this is
  // +1 for the move and +1 for node-error).
  // The package ceiling TIGHTENS 24 -> 23: `account/no-reuse-fetch.ts` stopped
  // importing `Readable` from `node:stream` when its hand-rolled body wrapper
  // became the global web ReadableStream, and nothing else in this composition
  // reaches `node:stream`. Re-measured, no headroom in either number.
  // +1 package (2026-09-06): `@claxedo/helpers/string` (reviewed owner
  // `packages/claxedo-helpers/src/string.ts`) replaces the local claim readers
  // in main. `string.ts` imports only `./guards` and touches no host API, so
  // the edge adds nothing this Electron main composition can execute. Module
  // count is unchanged because helpers sits outside `roots`. 90/24.
  // +2 modules (2026-09-08): `main/open-in-guard.ts`, the launch policy the
  // `open-path` handler asks before it reaches `execFile`, and
  // `main/open-in-apps.ts`, the app names that policy allows. Reviewed owner:
  // Electron main — the renderer control that used to supply an app name was
  // removed at the user's request, so the allowlist followed the guard into
  // this package instead of staying an `@claxedo/app` subpath outside `roots`.
  // That is why the second module counts here and did not before. The package
  // count is unchanged: `@claxedo/app` remains a package edge through
  // `process-diagnostics-contract`. 92/24.
  //
  // Re-measured 2026-09-17 at 90 modules / 24 packages; the two modules of
  // headroom had accrued unrecorded. Pinned with none.
  // +1 module (2026-09-19): `main/host-connector/serving-push.ts`, the one
  // owner of the hand-off from a heartbeat ack to the daemon's serving route —
  // the credential the machine dials the relay with and the addresses it
  // admits a relayed caller against. Reviewed owner: Electron main, which is
  // the only process that receives an ack and the only one that may reach the
  // daemon's loopback surface. It imports a type from `child-protocol.ts`
  // (already in this closure) and uses `fetch`, so no package edge. 91/24.
  // The name this machine is known by is derived in
  // `@claxedo/helpers/machine-name`, outside `roots`, because the self-hosted
  // node names itself the same way and one machine may not have two names.
  // The subpath is node-only (`node:os`, `node:fs`, `node:child_process`, all
  // already in this closure) and `@claxedo/helpers` is already a package edge
  // through `/string`, so it costs neither a module nor a package. Reviewed
  // owner: Electron main still CHOOSES the name and signs the enrollment it
  // travels on. Re-measured with no headroom: 91/24.
  // +1 module: `main/host-connector/provider-config-push.ts`, the one owner
  // of the hand-off from an opened provider-configuration revision to the
  // daemon's `/api/claxedo/host-provider-config` route. Reviewed owner:
  // Electron main, the only process that receives the child's opened text
  // and the only one that may reach the daemon's loopback surface; it
  // forwards the text and never parses it. Imports a type from
  // `child-protocol.ts` (already here) and uses `fetch`, so no package edge.
  // 92/24, no headroom.
  // +1 module net (2026-09-20): `main/daemon-request.ts` and
  // `main/renderer-daemon-access.ts` replace `main/renderer-origin.ts`. The
  // daemon now admits privileged calls only from the application that owns it,
  // and main is the process that presents that capability: once for its own
  // calls (`daemon-request.ts`, which also pins the destination and refuses
  // redirects) and once for the trusted renderer's (`renderer-daemon-access.ts`,
  // which stamps it onto that one frame's HTTP and WebSocket requests and
  // strips it from every other). Reviewed owner: Electron main, the only
  // process that may hold the token — the renderer must not, which is why the
  // stamping is here rather than a value handed over IPC. Electron-free by the
  // same seam split the navigation and IPC guards use, so no package edge.
  // 93/24, no headroom.
  // +1 module (2026-09-21): `main/store-policy.ts`, the one owner of the
  // settings-store boundary grammar — the basename check `getStore` applies to
  // renderer-supplied store names before `conf` resolves them to a path, and
  // the key/value bounds the store-* IPC handlers enforce. Electron-free so
  // `bun test` can exercise it (store.ts constructs electron-store at import),
  // reached from `main/ipc.ts` and `main/store.ts`; no package edge.
  // +4 modules (2026-09-21): the four decisions `main/ipc.ts` and
  // `main/windows.ts` used to make inline, each now an Electron-free owner so
  // `bun test` can exercise it. `main/open-in.ts` chooses which of reveal,
  // OS-handler open, confirmed-executable open or tool launch an `open-path`
  // request is; `main/renderer-permissions.ts` is what the app document may
  // ask the browser for; `main/server-url.ts` is what the renderer may persist
  // as the server main dials at next launch; `shared/zoom-factor.ts` is the
  // one zoom range, shared with the renderer that reports it. Reviewed owner:
  // Electron main, the only process that holds these OS and session
  // capabilities. Node builtins and type-only electron imports, so no package
  // edge.
  //
  // +1 module, +2 packages (2026-09-21): `main/daemon-recovery.ts`. It is the
  // external owner of a daemon that stopped answering HTTP, so it needs the two
  // things only those packages hold: `@claxedo/agent-sdk-runtime/launch` for
  // creation identity and identity-checked retirement, and
  // `@claxedo/agent-runtime-contract` for the recovery result it reports.
  // Reviewed owner: Electron main, which is the only process that launched the
  // daemon and the only one that may signal it; reimplementing either here
  // would be a second answer to "is this pid still that launch", and a guessed
  // one is what R8 was. Both packages are dependency-free data and OS reads,
  // with no server, runtime or store closure behind them.
  // 99/26, no headroom.
  ceilings: { modules: 99, packages: 26 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-main.json",
    minModules: 35,
    minChunks: 3,
    requiredModules: [
      `${DESKTOP}/main/index.ts`,
      `${DESKTOP}/main/account/lazy-account.ts`,
      // The closed operation table and its IPC registration, eager so that an
      // unsigned launch answers every account channel without constructing the
      // credential-bearing adapter.
      `${DESKTOP}/main/account/account-ipc.ts`,
      `${DESKTOP}/main/account/hosted-operations.ts`,
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
    // The hosted control plane. Main starts a LOCAL server child process; a
    // hosted server package in this graph is the split leaking backwards.
    // Main authenticates through its own OAuth/PKCE flow in
    // `src/main/account/oauth-flow.ts`, which speaks HTTP.
    "@claxedo/server",
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
  // +2 modules / -1 package (2026-09-06, oxlint type-aware sweep). The same two
  // `shared/` owners the base composition took, reached independently here:
  // `shared/node-error.ts` through `account/electron-seams.ts` and
  // `shared/json-read.ts` through `account/account-service.ts`. Both are leaves
  // over node builtins already in this closure, so they add no capability — they
  // are the errno narrowing and the JSON read this composition already did
  // inline, named once instead of copied.
  // The package ceiling TIGHTENS 7 -> 6 for the same reason as the base
  // composition: `account/no-reuse-fetch.ts` no longer imports `node:stream`.
  // Re-measured, no headroom in either number.
  // +1 package (2026-09-06): `account/identity.ts` reads its OIDC claims
  // through `trimToUndefined` from `@claxedo/helpers/string` (reviewed owner
  // `packages/claxedo-helpers/src/string.ts`) instead of a local copy that
  // shadowed the canonical two-arg `stringClaim` in `/guards`. No host API
  // behind that subpath; module count unchanged. 19/7.
  // +1 module / 0 packages (2026-09-07): reviewed owner
  // `account/cli-credential-file.ts`, the account's opt-in mirror into the
  // `claxedo` CLI's credential file. It belongs here because the credential it
  // mirrors never leaves this composition, and its only import beyond siblings
  // is `@claxedo/helpers/claxedo-credentials`, the file's shape and path —
  // already a package edge of this closure. Re-measured, no headroom: 20/7.
  ceilings: { modules: 20, packages: 7 },
  // The emitted list names the credential-bearing half only. `hosted-operations.ts`
  // and `account-ipc.ts` are reached from the base entry through
  // `lazy-account.ts`, so Rollup places them in `index.js`, and
  // `desktopMainComposition` requires them there: the closed channel set is
  // registered at startup precisely so signing in is what loads the adapter.
  // Measured at 12 modules / 2 chunks, no headroom.
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-account.json",
    minModules: 12,
    minChunks: 2,
    requiredModules: [
      `${DESKTOP}/main/account/index.ts`,
      `${DESKTOP}/main/account/credential-store.ts`,
      `${DESKTOP}/main/account/oauth-flow.ts`,
      `${DESKTOP}/main/account/desktop-native-auth.ts`,
      `${DESKTOP}/main/account/account-service.ts`,
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
 * unanswerable without following the edge — and the module that matters,
 * `platform/auth/better-auth-browser-auth.ts` (the one file that imports
 * `better-auth/client` and mints a token), is reached by walking straight into
 * `@claxedo/app`'s own source tree; the package's `exports` map has no
 * `"./auth"` subpath to hide behind. A walk that stops at the package
 * boundary reports a clean desktop closure and is wrong; it is exactly how the
 * desktop once shipped a browser identity SDK to every unsigned launch while
 * the app's own local guard stayed green.
 *
 * The source closure deliberately includes the dynamic hosted contribution so
 * it can reject a hosted-identity leak anywhere in the shipped renderer graph.
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

  forbiddenPackages: ["better-auth", "@claxedo/host-connector", "electron"],
  forbiddenModules: [
    // The module that MINTS a token — the one file that imports
    // `better-auth/client` and implements the browser auth client. There is no
    // `@claxedo/app/auth` subpath to reach it through; the package's `exports`
    // map only ever names `.` and `./process-diagnostics-contract`, so a
    // source walk finds this module only by following the plain in-package
    // import graph.
    `${APP}/platform/auth/better-auth-browser-auth.ts`,
    // The app's hosted browser entry.
    `${APP}/app/entry/main.tsx`,
    // Electron main is a different process. A renderer import of `src/main/**`
    // would put the machine private key and the OAuth client secret handling
    // in the window.
    `${DESKTOP}/main/account`,
    `${DESKTOP}/main/host-connector`,
  ],
  permittedOutsideRoots: MANIFEST_READS,

  control: {
    minModules: 700,
    requiredModules: [
      `${DESKTOP}/renderer/local.tsx`,
      `${DESKTOP}/renderer/shell.tsx`,
      // Reached only by crossing the package boundary. Its absence means the
      // walk never left `claxedo-desktop` — which is the state in which every
      // "no hosted identity" answer below is worthless.
      `${APP}/app/entry/app.tsx`,
      // Reached only through the `@/` alias from a DESKTOP file
      // (`renderer/shell.tsx` imports `@/platform/api/api`).
      `${APP}/platform/api/api.ts`,
    ],
    requiredPackages: ["solid-js"],
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
  // documents/optional service) + 1 (control-plane fetch) + 1 (SSE stream) + 1
  // (agent-config extensions) = 1007. The 16 lazy provider-settings locale
  // dictionaries shared with app-local bring this to 1023. The reviewed
  // deployable-service split adds the service contribution catalog, the
  // optional-service contribution roots, bootstrap-owner route, and canonical
  // private-session reservation client while retiring the monolithic hosted
  // contribution loader: net +5 modules. `@claxedo/service-contract` is the
  // one dependency-neutral package addition.
  // 2026-09-01: +2 `app/shell-revealed.ts` (the one window-once splash flag
  // both shell boundaries consult) and the unshare path through
  // `platform/remote-access` (machine-wide enrollment share toggle).
  // 2026-09-01: +1 `features/workspaces/data/auto-share-local-workspaces.ts`,
  // the same reconciler app-local took. Enabling remote access on the desktop
  // now publishes every local workspace the machine holds rather than the ones
  // a user ticked, and this is the module that keeps the two sets equal.
  // Reviewed owner: the workspaces data domain (see app-local.ts).
  // Session open/switch instrumentation (`platform/performance/session-perf.ts`
  // and its screen-side owner `features/session/ui/session-open-perf.ts`)
  // adds two modules and no package edge.
  // `platform/runtime/agent/cached-signed-workspace.ts` — the one reader of the
  // signed inventory from the shared Query cache: one module, no package edge.
  // Removing the retired local UI extension view, registry, and loader
  // subtracts three modules.
  // The Goal-mode merge adds the same session Goal owners app-local reviews
  // (composer intent/submission/draft, authority cache/query/controller,
  // runtime client/ingress, dock, Stop fallback + shared JSON reader):
  // thirteen modules.
  // `features/workspaces/data/workspace-catalog.ts` (the single catalog owner):
  // one more module, no package edge.
  // Settings scope: the same three Settings scope modules app-local
  // reviews (`features/settings/scope/settings-scope.tsx`, its pure
  // `settings-scope-options.ts`, and `features/settings/ui/scope-selector.tsx`)
  // — the explicit (workspace, harness) selection Providers and Models read
  // under. Reviewed owner: the settings feature; reachable only through the
  // already-lazy Settings dialog. Three modules, no package edge; the measured
  // closure is 1048.
  // The same two session-event-stream owners app-local reviews
  // (`platform/runtime/session-event-scope.ts` and
  // `app/integrations/claxedo-event-targets.ts`) are reachable from the
  // renderer's own events provider. Two modules, no package edge; the measured
  // closure is 1050.
  // `app/providers/global-sdk/route-event-scope.ts` reaches this renderer
  // through the same global-sdk provider; one module, no package edge; the
  // measured closure is 1051.
  // `app/providers/global-sdk/presentation-frames.ts` reaches it the same
  // way — the meaning half of the global-sdk provider. Reviewed owner: the
  // global-sdk provider; one module, no package edge; the measured closure is 1052.
  // `@claxedo/agent-event-runtime`'s `contracts/turn-message-ids` reaches this
  // renderer through the same session feature modules as the app entry: it is
  // the one owner of the runtime's turn message-id convention, which the
  // session transcript reads to place a reply under the message it answers.
  // Reviewed owner: the agent event contracts package, already in this
  // closure; one module, no package edge.
  // -46 modules / -3 packages: retiring the hosted work-ledger service took its
  // renderer contribution loader and the whole app-side surface graph out of
  // the unsigned renderer. Re-measured, no headroom.
  // +6 modules / 0 packages (2026-09-04): the Agent Plugins marketplace became a
  // Directory (search, source chips, cards, detail pane, add-source form) plus
  // an install sheet, the shared connections helper, and the signed desktop's
  // DirectoryApi over hosted operations, replacing the single catalog surface.
  // Reviewed owner: features/agent-plugins (this product's own surface); every
  // edge stays inside packages already in the closure. Re-measured, no headroom.
  // +7 modules / 0 packages (2026-09-04, polish): the Directory split into status,
  // facts, actions, MCP rows, skill view, overflow menu, pane width, and chrome
  // modules; every edge stays inside packages already in the closure. Re-measured, no headroom.
    // +1 module (2026-09-04): the Personal entry pane. Re-measured, no headroom.
  // +2 modules (2026-09-05): the New Project flow rule and the
  // folder-versus-cloud chooser reached through the shared project actions
  // (see app-local.ts for the owner).
  // +8 modules / 0 packages (2026-09-06, oxlint type-aware sweep). This entry
  // renders the same app the local product does, so it takes app-local's nine
  // new named owners and one deletion verbatim — see the ledger in
  // `app-local.ts` for what each one owns — plus `shared/json-read.ts`, reached
  // here through `renderer/remote-access/electron-machine-remote-access.ts`.
  // No new package edge: 56 is unchanged. Re-measured, no headroom.
  // +1 package (2026-09-06): @claxedo/helpers enters the closure through the
  // shared app surface (see app-local.ts for the owner). Re-measured after the
  // test-quality audit merge retired the per-file readers: 1009/57, no headroom.
  // +1 module / 0 packages (2026-09-07): this entry renders the same app, so it
  // takes app-local's control-plane session-record owner verbatim — see the
  // ledger in `app-local.ts`. Re-measured, no headroom.
  // +1 module / 0 packages (2026-09-07): the same app, so it also takes
  // app-local's rail session-activity owner verbatim — see that ledger.
  // Re-measured, no headroom.
  // +30 modules (2026-09-07): the workspace panel's source-control Changes
  // column, its git client, status query and mutations, the 17 lazy
  // source-control locale dictionaries, the process-pane registry behind the
  // Processes column, and the floating pane presentation, all reached through
  // the shared app surface (see app-local.ts for the owner). Re-measured, no
  // headroom.
  // +2 modules (2026-09-07): the Compared changes group and its diff summary
  // query, reached through the same Changes column (see app-local.ts for the
  // owner). Re-measured, no headroom.
  // +1 module (2026-09-07): the floating card's transcript peek reducer
  // `features/session/ui/transcript-peek.ts` (see app-local.ts for the owner).
  // Re-measured, no headroom.
  // +3 modules (2026-09-08): the same three Settings → Providers owners
  // app-local reviews — the agents section, the harness catalog section, and
  // the detection reader over the onboarding scan. No new package edge.
  // Re-measured, no headroom.
  // +2 modules (2026-09-08): the same restored custom-provider dialog and its
  // validation module app-local reviews, reached through the shared provider
  // picker. No new package edge. Re-measured, no headroom.
  // +1 module (2026-09-08): the same `/mcp` catalog split app-local reviews —
  // the feature-owned dialog body plus the app-owned rail picker. No new
  // package edge. Re-measured, no headroom.
  // -2 modules (2026-09-08): the same Open in… / Copy path removal app-local
  // reviews — the control, and the app-name allowlist that moved into
  // `main/open-in-apps.ts`, which no renderer reaches. Re-measured, no
  // headroom.
  // +3 modules (2026-09-08): the same connected-apps UI, consent API and
  // auth-error owner reviewed by app-local; server-routes replaces the old
  // client contract. Full verify:closure measured 1056 / 57, no headroom.
  // +1 module (2026-09-08): local-event-websocket owns the loopback
  // WebSocket `ClaxedoEventsProvider` reads `cp/events` over, so several
  // windows do not exhaust the browser's HTTP slots. Measured 1057 / 57.
  // +1 module (2026-09-09): the same terminal agent catalog / saved-commands
  // owner app-local reviews, reached from the rail and the terminal creator.
  // No new package edge. Measured 1058 / 57.
  // +1 module (2026-09-11): review-workspace-tab-button, the workspace panel's
  // one tab chip. It splits out of review-workspace.tsx, which the subagent tab
  // pushed past the 800-line budget, and imports only what that file already
  // did. It sits in the slot `session-order-hold` opened and never recorded,
  // which `session-bands` inherited one-for-one and freed when the rail's
  // ordering moved to the server's list. No new package edge. Measured 1059 / 57.
  // +3 modules (2026-09-12): the same three owners app-local reviews —
  // workspace-panel-working-set, pending-prompt-registry, timeline-link-open.
  // No new package edge. Measured at a clean checkout: 1061 / 57.
  // +1 module (2026-09-12): the same review-workspace-subagent-tabs owner
  // app-local reviews. No new package edge. Measured at a clean checkout: 1062 / 57.
  // +3 −2 modules (2026-09-12): the same Settings → Models rebuild app-local
  // reviews — the harness model-options loader, the page's query hook and
  // stylesheet in, the Connect-your-AI dialog and the scope pickers out.
  // No new package edge. Measured 1063 / 57.
  // +1 module (2026-09-12): the same timeline-mount-cache owner app-local
  // reviews. No new package edge.
  // +2 modules (2026-09-13): the same agent-harness-row and provider-connect-card
  // owners app-local reviews. No new package edge.
  // +1 module (2026-09-13): the same harness-catalog owner app-local reviews.
  // No new package edge.
  // +1 module (2026-09-13): the same connect-methods owner app-local reviews.
  // No new package edge.
  // +1 module (2026-09-13): the same lib/percent.ts owner app-local reviews.
  // No new package edge.
  // +1 module (2026-09-14): the same account agent-settings API owner
  // app-local reviews. No new package edge.
  //
  // Tasks and Presets reach this renderer through the shell's secondary port
  // wiring, under exactly the owners `app-local` reviews — including the
  // Documents editor the user accepted on 2026-09-13, the first-project canvas
  // and the contributed settings section. `@claxedo/tasks` is the one package
  // edge they add; this renderer already carried the Tiptap edges through its
  // hosted half.
  //
  // +2 modules (2026-09-15): the same queued-message owners —
  // `features/session/queue/queued-messages-controller.ts`,
  // `features/session/ui/timeline-queued-messages.tsx` and
  // `composer/ui/submit-queued-edit.ts`, less the composer overlay they
  // replace — see the app-local ledger. Re-measured, no headroom.
  //
  // +1 module (2026-09-15): the same session idle-return scroll owner
  // `features/session/ui/idle-return-scroll.ts` — see the app-local ledger.
  // Re-measured, no headroom.
  //
  // +2 modules (2026-09-14): the same two task-image owners,
  // `features/tasks/ui/dialogs/image-drafts.ts` and
  // `features/tasks/ui/detail/task-attachments.tsx` — see the app-local ledger.
  // Re-measured, no headroom.
  //
  // +1 module (2026-09-16): the same dev-only transcript typography panel
  // `app/workbench/rail/rail-transcript-typography-panel.tsx` — see the
  // app-local ledger. Re-measured, no headroom.
  //
  // +1 module (2026-09-16): `app/workbench/context/pane-ctx.tsx` — see the
  // app-local ledger. Re-measured, no headroom.
  //
  // +1 module (2026-09-16): `features/tasks/ui/shared/title-field.tsx` — see
  // the app-local ledger. Re-measured, no headroom.
  //
  // +1 module (2026-09-17): `features/session/composer/collapsed-state.ts` —
  // see the app-local ledger. Re-measured, no headroom.
  //
  // +1 module (2026-09-17): `platform/settings/transcript-typography.ts` —
  // see the app-local ledger. Re-measured, no headroom.
  //
  // +1 module (2026-09-17): `features/session/store/session-history-resync.ts`
  // — see the app-local ledger. Re-measured, no headroom.
  //
  // -4 modules (2026-09-17): the second stream reader — see the app-local
  // ledger.
  //
  // +1 module (2026-09-20): `features/settings/remote-access/machine-provider-config.tsx`
  // — see the app-local ledger. The renderer's port leaves `providerConfig`
  // absent, so the control never renders here; the module rides in with the
  // shared surface.
  //
  // +1 module (2026-09-20): `app/connection/deployment-posture.ts` — see the
  // app-local ledger. Only the in-tree reader reaches this renderer; the
  // pre-render resolver (`app/boot/data/deployment-posture.ts`) is an entry's
  // call and `renderer/local.tsx` does not make it.
  //
  // +17 modules (2026-09-20): `platform/i18n/machines/<locale>.ts` — see the
  // app-local ledger. The renderer shares the i18n manifest, so every locale
  // file the manifest imports rides in here too. Measured 1139 modules / 58
  // packages, with no headroom.
  // +1 module (2026-09-20): `renderer/external-link.ts` owns the shell's
  // document-click handoff to the OS, respecting clicks already claimed by
  // the transcript. Extracted from shell.tsx for DOM integration coverage;
  // it adds no dependency edges of its own. Measured 1140 / 58, no headroom.
  // Two retained shared owners: claxedo-tool-href routes tool resources through
  // existing workspace navigation; draft-session-start persists creation-owner
  // references and reads canonical session lifecycle status. ACP questions use
  // the unchanged question dock; its separate UI, worker, query and action
  // modules have been removed.
  // +1 module (2026-09-21): `lib/open-link.ts` — see the app-local ledger.
  // The terminal link fallback reaches it in the shared renderer bundle; the
  // desktop's own openLink still goes through the scheme-gated `open-link`
  // IPC in main.
  // +1 module (2026-09-21): `ui/mermaid.ts` — see the app-local ledger. The
  // shared renderer bundle carries it for the session timeline and the
  // documents editor.
  // +1 module (2026-09-21): `shared/zoom-factor.ts` — the one zoom range,
  // reached from `renderer/webview-zoom.ts`. The renderer keeps its own record
  // of the zoom it asked for, and main clamps the IPC argument with the same
  // constants, so a second range here would let the two disagree. Constants
  // and `Math`, no dependency edges.
  // +2 modules (2026-09-21): `features/session/ui/recovery-outcome-copy.ts` and
  // `features/session/ui/session-recovery.tsx` — see the app-local ledger. The
  // renderer shares the session feature's composer region, which is what mounts
  // the panel, so both ride in here too; no new package edge.
  // +19 modules (2026-09-22): the recovery size split — see the app-local
  // ledger. The renderer shares the i18n manifest and the session feature, so
  // the themed dictionary and both extracted owners ride in here too; no new
  // package edge.
  // +1 module (2026-09-22): `features/session/ui/message-timeline-list-gestures.ts`
  // — see the app-local ledger. The renderer mounts the same timeline, so the
  // split owner rides in here too; no new package edge. Exact measured 1167
  // modules / 58 packages, with no headroom.
  // +1 module (2026-09-22): `features/session/ui/model/model-list.tsx` — see
  // the app-local ledger; the renderer shares the session screen that mounts
  // the first-turn onboarding, so the split rides in here too. No new package
  // edge.
  // +3 modules (2026-09-22): Settings became a shell surface instead of a
  // dialog — `platform/settings/route.ts`, `features/settings/settings-surface.tsx`
  // and the nav/content/registry split that replaced `settings-page.tsx`,
  // `app/dialogs/settings.tsx` and `features/settings/open-settings.tsx`. The
  // rail lists the sections and the workbench column draws the open one, so
  // the surface is reachable from the shell rather than from a lazy dialog;
  // the nav itself is still lazily imported so the panels stay out of the
  // shell's chunk. Owner: `features/settings`. No new package edge.
  // +1 module (2026-09-22): `features/settings/ui/settings-header.tsx` — the
  // settings column's own bar, one tab and the sidebar control, replacing the
  // workbench header that acts on a workspace. Owner: `features/settings`.
  // +1 module (2026-09-22): `features/settings/ui/dialog-provider-connect.tsx`
  // — connecting an account moved out of the row it came from and into a
  // dialog, so the list stays where the user left it. Owner:
  // `features/settings`. No new package edge.
  // +2 modules (2026-09-22): `features/settings/ui/machines-section.tsx` and
  // `platform/remote-access/machine-online.ts` — the Machines panel is
  // Settings' own surface now (the fleet list and the enrollment instructions
  // left the shared onboarding surface, which enrolls one machine and has no
  // list), and a machine is reported connected by one rule both halves read.
  // Owner: `features/settings`. No new package edge.
  // Exact measured 1174 modules / 58 packages, with no headroom.
  // Both ledgers above landed in one merge on 2026-09-22; the closure was
  // re-measured over the merged tree rather than added up. Exact measured
  // 1174 modules / 58 packages, with no headroom.
  // +1 module (2026-09-22): `app/workbench/workbench/drop-target.ts` — the
  // workbench's own drop zone, split out of `workbench.tsx` to keep that file
  // under the 800-line budget when the pane hit test was bounded to the
  // workbench root. It sits beside the drag helpers it already used and
  // reaches nothing new. Owner: `app/workbench/workbench`. No new package edge.
  ceilings: { modules: 1175, packages: 58 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-local.json",
    minModules: 700,
    minChunks: 1,
    requiredModules: [
      `${DESKTOP}/renderer/local.tsx`,
      `${DESKTOP}/renderer/shell.tsx`,
      `${APP}/app/entry/app.tsx`,
      // The base reads this registry and optional activation binds the same
      // instance through a shared chunk; only the Electron adapter is optional.
      `${APP}/platform/remote-access/machine-remote-access.ts`,
    ],
    forbiddenModules: [
      `${DESKTOP}/renderer/hosted-contributions.ts`,
      `${APP}/app/composition/hosted-contribution-loader.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access-binding.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access.ts`,
    ],
    // This manifest is the renderer's STATIC closure —
    // `desktopRendererBoundaryManifestPlugin` builds the base entry without
    // `includeDynamicImports` — and the only edge into Tasks is the dynamic
    // import in `secondary-feature-ports.ts`, so no Tasks module or chunk can
    // appear in it. `app-local`'s emitted manifest records the full closure and
    // is where the Tasks chunk is measured.
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
  forbiddenPackages: ["better-auth", "@claxedo/host-connector", "electron"],
  forbiddenModules: [
    // The module that MINTS a token (imports `better-auth/client`); see
    // `desktopRendererUnsigned` above for why there is no `@claxedo/app/auth`
    // subpath to reach it through instead.
    `${APP}/platform/auth/better-auth-browser-auth.ts`,
    `${APP}/app/entry/main.tsx`,
    `${DESKTOP}/main`,
  ],
  permittedOutsideRoots: MANIFEST_READS,
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
  // contract, so the reviewed closure deliberately shrinks from 322/40: the
  // Goal-mode session owners are reached from their own service roots, not
  // from this activation entry.
  //
  // It also binds the cloud workspace-startup port, because this is the only
  // desktop binding of it and shared composer code (`submit-directory.ts`,
  // `session-actions.tsx`) calls `workspaceStartup()` on desktop too. That
  // reaches the canonical cloud-startup owners — `workspace-runtime-store`,
  // `workspace-relay-connection`, and the AccountPort call/decode pair — and
  // through the store's query cache the one package edge, `@tanstack/solid-query`.
  // Measured at 43/1; `renderer-entry-closure.guard.test.ts` pins the exact
  // hosted module set so a sixth is a new edge to review, not a number to bump.
  // The 43rd module is `platform/identity/harness-selection.ts`, reached from
  // `agent-runtime-client.ts` since the generic-harness cutover made the
  // selection (native harness vs configured connection) a typed value.
  // +4 modules / 0 packages (2026-09-06, oxlint type-aware sweep), on top of the
  // 43rd above. All four are leaves with no capability of their own, which is
  // why `renderer-entry-closure.guard.test.ts` above is unchanged: its pinned
  // set is the `platform/account/`, `platform/runtime/cloud/` and Documents
  // prefixes, and only one of these four lands in it — `preload-bridge.ts`,
  // already pinned there. Reviewed owners:
  //   claxedo-app/src/lib/record.ts — the app's one record predicate/reader set,
  //     from `workspace-runtime-store.ts`, replacing its inline narrowing;
  //   claxedo-app/src/lib/server-errors.ts — from `workspace-relay-connection.ts`;
  //   claxedo-app/src/platform/account/preload-bridge.ts — the `api.account`
  //     global read, from `hosted-control-call.ts`;
  //   claxedo-desktop/src/shared/json-read.ts — from
  //     `renderer/remote-access/electron-machine-remote-access.ts`.
  // Still one package edge (`@tanstack/solid-query`). Re-measured, no headroom.
  // The second package edge is `@claxedo/helpers`, the canonical owner of
  // `isLoopbackHttpUrl`, reached from `platform/api/api.ts`. Its root barrel is
  // the runtime-neutral surface — no `node:` import can appear there, those live
  // behind `/fs`, `/path`, `/process`, `/net` — so it is safe on a renderer
  // graph. Module count is unchanged at 47; only the package edge moved.
  ceilings: { modules: 47, packages: 2 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-hosted-contributions.json",
    minModules: 4,
    minChunks: 1,
    requiredModules: [
      `${DESKTOP}/renderer/hosted-contributions.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access-binding.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access.ts`,
    ],
  },
}
