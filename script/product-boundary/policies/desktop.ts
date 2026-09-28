import type { Policy } from "../policy.ts"
import type { Alias } from "../closure.ts"

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
  // Renderer trust/readiness and native Mermaid supervision add nine
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
  // +1 module (2026-09-25): `shared/desktop-product.ts`, the one owner of the
  // packaged app id and product name. The builder config reads it to name the
  // bundle and main reads it to name userData and the Keychain item. Reviewed
  // owner: Electron main, which sets both at startup. No imports, no package edge.
  // +1 module, +1 package (2026-09-25): `main/renderer-content-security.ts`
  // stamps the renderer's Content-Security-Policy on its documents, built by
  // `@claxedo/app/content-security-policy` (one file, no imports), the same
  // builder the web build uses, so the desktop and the web lock the app to one
  // exact server origin by one rule. Reviewed owner: Electron main, the only
  // place that knows the daemon's origin before the document loads and the
  // only one a page cannot rewrite.
  // +1 module (2026-09-26): `shared/local-diagnostics.ts`, the process
  // diagnostics contract (zod schemas) main's diagnostics collectors, IPC and
  // preload validate against. It moved here from the old app, where the walk
  // counted it only as that package's edge. Reviewed owner: the desktop, now
  // its only user. Packages stay at 27: `zod`, its one import, joins, and the
  // two app package edges (old app, app-v2) become one, `@claxedo/app`.
  // 102/27, no headroom.
  // -1 module (2026-09-27): `shared/json-read.ts` is gone. Its field readers
  // are `@claxedo/helpers/readers`, the one owner the app reads through too;
  // `@claxedo/helpers` was already a package edge and sits outside `roots`.
  // 101/27, no headroom.
  // -1 module (2026-09-27): `main/native-markdown.ts` is gone with the native
  // Markdown renderer nothing called. 100/27, no headroom.
  // +1 module (2026-09-27): `main/daemon-status.ts`, the one owner of the
  // daemon status main publishes to the renderer when its lease closes or the
  // daemon it started exits. Reviewed owner: Electron main, the only process
  // holding the lease and the child. Type-only import of the restart policy,
  // no package edge. 101/27, no headroom.
  ceilings: { modules: 101, packages: 27 },
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

  // 18 modules and 7 packages, no headroom. `account/no-reuse-fetch.ts`, the
  // fresh-connection node http(s) fetch, brings `node:https`.
  // `account/cli-credential-file.ts` mirrors the account's credential into the
  // `claxedo` CLI's credential file; that credential never leaves this
  // composition, and `@claxedo/helpers/claxedo-credentials` is its file shape
  // and path. The `@claxedo/helpers` subpaths (`fs`, `guards`, `readers`,
  // `string`) are leaves over node builtins already in this closure.
  ceilings: { modules: 18, packages: 7 },
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
 * How the renderer build resolves the app's specifiers.
 *
 * `vite.renderer.ts` builds the renderer from the app's own Vite config, so
 * these mirror its aliases: `#app` and `#app/styles` are the renderer's door
 * into the app, `@/` is the app's own source root, and `#account-binding` is
 * the desktop's account binding, which the renderer config always selects.
 * Nothing resolves them from a package manifest, so a walk without this list
 * answers "unresolved" for every app module and reports a clean product it
 * never opened. `#app/styles` comes before `#app`, whose target is a file.
 */
const RENDERER_ALIASES: Alias[] = [
  { prefix: "#app/styles", target: `${APP}/styles.ts` },
  { prefix: "#app", target: `${APP}/app.tsx` },
  { prefix: "#account-binding", target: `${APP}/auth/electron-binding.ts` },
  { prefix: "#terminal-backend", target: `${APP}/terminal/backend/xterm.ts` },
  { prefix: "@claxedo/app/ui", target: `${APP}/ui/index.ts` },
  { prefix: "lru_map", target: `${APP}/transcript/diff/lru-map.ts` },
  { prefix: "@", target: APP },
]

/**
 * The desktop renderer: the app, entered through `src/renderer/main.tsx`.
 *
 * This crosses INTO `@claxedo/app` on purpose. The renderer is the app, so
 * "what does the desktop window reach" is unanswerable without following the
 * edge. The module that matters is the browser account binding
 * (`auth/better-auth-binding.ts`, the one file that imports
 * `better-auth/client`): the desktop signs in through Electron main, and the
 * renderer config selects the Electron binding, so that module and its
 * package must never be reached.
 */
export const desktopRenderer: Policy = {
  id: "desktop-renderer",
  summary: "@claxedo/desktop renderer entry (src/renderer/main.tsx)",
  packageDir: "packages/claxedo-desktop",
  entry: `${DESKTOP}/renderer/main.tsx`,
  roots: [DESKTOP, APP],
  aliases: RENDERER_ALIASES,
  followed: [{ name: "@claxedo/app", dir: "packages/claxedo-app" }],

  forbiddenPackages: ["better-auth", "@claxedo/host-connector", "electron"],
  forbiddenModules: [
    `${APP}/auth/better-auth-binding.ts`,
    // Electron main is a different process. A renderer import of `src/main/**`
    // would put the machine private key and the OAuth client secret handling
    // in the window.
    `${DESKTOP}/main/account`,
    `${DESKTOP}/main/host-connector`,
  ],
  // A plugin's code is a blob: URL built at runtime from the bundle the user
  // installed, so neither edge is repository source. `plugins/bundle.ts` loads
  // a desktop plugin into the window; `plugins/frame/document.ts` holds, as a
  // string, the loader the web's sandboxed plugin frame runs.
  permittedOpaqueImports: [
    `${APP}/plugins/bundle.ts -> import(url)`,
    `${APP}/plugins/frame/document.ts -> import(url)`,
  ],

  control: {
    minModules: 700,
    requiredModules: [
      `${DESKTOP}/renderer/main.tsx`,
      // Reached only by crossing into the app through `#app`. Its absence means
      // the walk never left `claxedo-desktop`, which is the state in which
      // every "no browser identity" answer below is worthless.
      `${APP}/app.tsx`,
      `${APP}/auth/electron-binding.ts`,
    ],
    requiredPackages: ["solid-js"],
  },

  // 1,210 modules and 38 packages, no headroom. The Review tab's
  // `review/loaded-diff-identity.ts` is its own module because the benchmark
  // driver imports it to compute the identity it waits for. The workbench
  // store's pane handover (`workbench/handover.ts`, `workbench/reveal-holds.ts`)
  // is the app's session-switch paint: one pane swap per switch, after the view
  // it reveals is complete. A session opens from one first read
  // (`server/wire/first-read.ts`) carrying its row, its turn outline and the
  // page its transcript draws first, sized by `session/transcript-viewport.ts`
  // from the transcript's measured size; the open view
  // (`server/wire/session-open.ts`) carries the facts beside the row. Every
  // later page and a tool row's whole part are read by
  // `server/transcript-reads.ts` and parsed by `server/wire/turn-page.ts`. The
  // rail's turn list (`session/view/nav-turns.ts`) lists every turn before the
  // transcript loads it, and `session/transcript/retained.ts` holds the latest
  // turn a return repaints from. The timeline's render range
  // (`session/view/timeline/timeline-render-range.ts`) is its own module so its
  // unit tests reach it without mounting the timeline.
  // The outgoing slot unmounts after the swap paints
  // (`workbench/view/deferred-unmount.ts`).
  // The kit (`@opencode-ai/ui`) is one of the packages; its source is not
  // walked. `@claxedo/agent-event-runtime/contracts` is one too: it owns the
  // event streams' heartbeat and the stall timeout the app's stream reader
  // drops a silent stream after. The shell's `shell/daemon-status.ts` and
  // `shell/view/daemon-lost-banner.tsx` are the desktop's one alert that its
  // local service stopped. `server/model-choice.ts` is the one comparison of two
  // model choices, read by the composer's model selection and by the session
  // list's rule for a row that changes only its selections.
  ceilings: { modules: 1210, packages: 38 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-local.json",
    minModules: 700,
    minChunks: 1,
    requiredModules: [`${DESKTOP}/renderer/main.tsx`, `${APP}/app.tsx`, `${APP}/auth/electron-binding.ts`],
    forbiddenModules: [`${APP}/auth/better-auth-binding.ts`],
    forbiddenChunkMarkers: ["vendor-better-auth"],
  },
}
