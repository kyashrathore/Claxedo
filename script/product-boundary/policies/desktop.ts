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
  // publishes display name/email after OAuth. The
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
  // `@claxedo/helpers/machine-name`, outside `roots`, because `claxedo connect`
  // names its machine the same way and one machine may not have two names.
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
  // things only those packages hold: `@claxedo/process-ownership/launch` for
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
  // -1 module: `account/account-perf.ts` is gone with the account-port bench,
  // its only reader. 100/27, no headroom.
  // +1 package (2026-09-30): `@claxedo/plugin-api/id`, reached through
  // `account/hosted-operations.ts`. Reviewed owner: the plugin id rule, which
  // main applies to `plugin.request`'s plugin id before it builds a URL. The
  // subpath is one zod-free module. 100/28, no headroom.
  // -13 modules / -4 packages: process diagnostics are gone — the
  // `main/diagnostics/` collectors, profiler, workers and IPC and the
  // `shared/` diagnostics transport — and with them `zod`,
  // `@vscode/windows-process-tree`, `node:readline` and `node:util`.
  // 87/24 with the plugin id subpath above, no headroom.
  // -1 module: the hosted operation table is `@claxedo/account-contract`'s
  // own, so `account/hosted-operations.ts` is gone; the plugin id subpath now
  // arrives through that package. 86/24, no headroom.
  // +1 module: `main/auto-update.ts`, the packaged app's update check, prompt
  // and install, split out of `index.ts` along its own responsibility.
  // Reviewed owner: Electron main, the only process that drives
  // `electron-updater`, already a package edge. 87/24, no headroom.
  // +1 module / +1 package: `main/local-file-content.ts` over
  // `@claxedo/workspace-runtime/file-content`. Reviewed owner: workspace-runtime's
  // canonical file-content reader, which the workspace `/file/content` route
  // also serves; main applies only the local-path guard before it. The subpath
  // is one module; its other imports, a contract type and
  // `@claxedo/helpers/fs`, are already edges. 88/25.
  // -1 module: `main/claude-executable.ts` is gone; the runtime resolves the
  // Claude CLI itself from the PATH main hands the daemon. -1 module:
  // `main/daemon-exit-lifecycle.ts` is gone; shutdown stops the lease directly.
  // +4 modules: `main/app-lifecycle.ts` (closing keeps the app running, quit
  // confirms and stops the daemon), `main/lifecycle-ui.ts` (its tray and quit
  // dialog), `main/daemon-quit.ts` (drain, then the daemon's own stop) and
  // `main/daemon-launch.ts` (adopt, replace or hold a published daemon by
  // build). Reviewed owner: Electron main, which alone holds the window, the
  // lease and the daemon's capability; `electron` and the recovery contract
  // were already edges. 90/25.
  // +1 module: `main/update-install.ts`, which relaunches this build when a
  // downloaded update fails to install after the daemon was stopped. Reviewed
  // owner: Electron main's updater; it is split from `auto-update.ts` only so
  // it runs without the `electron` runtime. 91/25, no headroom.
  ceilings: { modules: 91, packages: 25 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-main.json",
    minModules: 35,
    // Main has one Rollup entry, so every module the base shares with the lazy
    // account adapter stays in index.js and the adapter imports it from there;
    // the base's static closure is that single chunk.
    minChunks: 1,
    requiredModules: [
      `${DESKTOP}/main/index.ts`,
      `${DESKTOP}/main/account/lazy-account.ts`,
      // The IPC registration over the closed operation table, eager so that an
      // unsigned launch answers every account channel without constructing the
      // credential-bearing adapter.
      `${DESKTOP}/main/account/account-ipc.ts`,
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
    // (`src/server/entry.ts`), never in-process.
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
      `${DESKTOP}/main/account/credential-store.ts`,
    ],
    requiredPackages: ["electron", "@claxedo/account-contract"],
  },

  // 17 modules and 7 packages, no headroom. `account/no-reuse-fetch.ts`, the
  // fresh-connection node http(s) fetch, brings `node:https`.
  // `account/cli-credential-file.ts` mirrors the account's credential into the
  // `claxedo` CLI's credential file; that credential never leaves this
  // composition, and `@claxedo/helpers/claxedo-credentials` is its file shape
  // and path. The `@claxedo/helpers` subpaths (`fs`, `guards`, `readers`,
  // `string`) are leaves over node builtins already in this closure.
  // `@claxedo/plugin-api/id` is the plugin id rule `@claxedo/account-contract`
  // applies to `plugin.request`, one zod-free module. The operation table is
  // that package's own: 16 modules, 8 packages.
  ceilings: { modules: 16, packages: 8 },
  // The emitted list names the credential-bearing half only. `account-ipc.ts`
  // and the operation table are reached from the base entry through
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

  // 1,224 modules and 37 packages, no headroom. The Review tab's
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
  // walked. `@claxedo/agent-runtime-contract` is one too: among the data the
  // app reads from it, it owns the event streams' heartbeat and the stall
  // timeout the app's stream reader drops a silent stream after. The shell's `shell/daemon-status.ts` and
  // `shell/view/daemon-lost-banner.tsx` are the desktop's one alert that its
  // local service stopped. `server/model-choice.ts` is the one comparison of two
  // model choices, read by the composer's model selection and by the session
  // list's rule for a row that changes only its selections. The Usage settings
  // section (`usage/view/*`) is a renderer screen: its model owns the quota
  // account groups, window risk, the cost estimate, the daily series and the
  // token split, each a module its unit tests reach directly, and it draws the
  // shared `lib/failure.tsx` notice and the kit's collapsible. The rail and
  // settings rows take their height, radius and type size from one stylesheet
  // (`shell/view/sidebar.css`), and `notifications/unseen-failures.ts` owns
  // which failed sessions the reader has not opened, the one fact the rail's
  // failure dot reads. The Review column's file row (`review/view/change-row.tsx`),
  // its muted diff counts (`review/view/change-counts.tsx`), which the review
  // toolbar's totals also draw, and its folder label (`review/folder-label.ts`),
  // which its unit test reaches directly, are modules of their own. Settings'
  // own-or-team account choice reads and writes through
  // `server/account-sources.ts` and draws `accounts/view/hosted-account-source.tsx`;
  // the slash picker reads a harness's runtime and saved commands through
  // `server/harness-commands.ts`, parsed by `server/wire/harness-commands.ts`;
  // and onboarding's choice of where the first project lives, the draft it
  // holds and the creation Finish opens are `onboarding/{place,model,finish}.ts`.
  // A session's activity for the rail, workbench tabs and plugins is one
  // reading (`session/list/activity.ts`); the transcript's background work
  // line and its label are `session/view/timeline/timeline-background-work.tsx`
  // and `background-work-label.ts`, which its unit test reaches directly; and a
  // running background subagent's Stop beside its chip is
  // `transcript/subagent-stop.tsx`.
  // The transcript draws a harness's notices and compaction boundaries from the
  // contract's `transcript-notice.ts` through `transcript/notice-part.tsx`, whose
  // pure view (`notice-view.ts`) its unit test reaches directly, on the divider
  // it shares with the compaction part (`message-divider.tsx`). A response the
  // harness withdrew draws through `transcript/retracted-part.tsx`, and the edit
  // tools' diagnostics list is `transcript/tool-diagnostics.tsx`. A queued
  // message's label, reason and send action, including a steer the harness
  // declined, are `session/view/timeline/queued-message-status.ts`, which its
  // unit test reaches directly.
  // SidePanel owns shared frame, header, tab, resize and motion; the panel and
  // Marketplace wrappers reach it through ui, with workspace data kept outside.
  // side-panel-slot lets the active page use that full-height shell host.
  // Settings' provider model cards share their switch rows and large-provider
  // virtualization through `accounts/view/model-rows.tsx`. A long user prompt
  // folds through `transcript/folded-user-message-body.tsx` and its stylesheet.
  // A child's report and a stored agent-authored opening share the event chrome
  // of `transcript/agent-message-event.tsx`, styled by
  // `transcript/agent-message-notice.css`. Sessions other people shared with
  // the account are read and routed by `server/shared-sessions.ts` and listed
  // by `rail/view/shared-sessions.tsx`. Whether the macOS window buttons cover
  // the shell's top-left corner is `shell/window-controls.ts`, read through the
  // desktop bridge. A comment on text selected in the transcript, a Markdown
  // preview or the plan tab is `composer/quote/selection-comment.tsx` over its
  // selection controller (`quote-selection.ts`), its pure selection reading and
  // box placement (`selected-quote.ts`, which its unit test reaches directly)
  // and its highlight stylesheet; the composer groups quotes through
  // `composer/view/annotations-chip.tsx`, with details and actions in
  // `annotation-card.tsx`, and a sent message through
  // `session/view/timeline/message-comment-chip.tsx`. Every comment box, line,
  // mark or quote, is `transcript/line-comment-editor.tsx`, apart from the
  // anchor and saved comment in `line-comment.tsx`. Composer owns the source
  // registry (`quote/surfaces.tsx`), range lookup (`find-quote.ts`), edit
  // controller (`annotation-editor.tsx`), shared placement and highlight
  // (`anchored-position.ts`, `highlight.ts`) and popup (`quote-box.tsx`). Its
  // context chips share their remove control through `view/context-chip.tsx`;
  // mark and quote positioning share the bounded coordinate in `coordinate.ts`.
  // These renderer interactions add no package edge.
  // The draft context reaches `projects/draft-branches.ts`, which owns the
  // selected placement's live Git status and new-workspace base choice.
  // The Browser tab's retained pages, their eviction and their disposal when a
  // placement is deleted are `browser/tab-cache.ts`, split from the provider
  // that owns the context. The composer's pure prompt edits (insert a part,
  // renumber offsets, set image marks) are `composer/prompt-edits.ts`, split
  // from the draft store; the harness selector's model, effort and fast writes
  // and their refusal toast are `composer/view/selection-writes.ts`.
  // server/startup.ts owns startup failure and retry; shell/view/startup.tsx
  // presents that state through the existing failure notice. Both belong in
  // the shared desktop renderer and add no package edge.
  // `app.tsx` mounts the session state owners through `session/index.ts`'s
  // `SessionStoresProvider` (`session/store/*`): the session list
  // (`session/list/*`), the pending permissions and questions
  // (`session/requests/*`) and each open session's transcript
  // (`session/transcript/*`). The renderer draws all of them; they add no
  // package edge.
  // The session stores derive a row's finished, failed and waiting alerts in
  // `session/store/attention.ts`, and a signed desktop reads its account's
  // hosted event stream through `server/account-events.ts`.
  // A reader's seen and settle writes, and where a signed desktop's marks live,
  // are `server/session-reader.ts`; the list holds each row's reader marks in
  // `session/list/readers.ts` and sends its pending writes from
  // `session/list/reader-writes.ts`; the session view's seen write while a
  // session is shown is `session/view/seen-while-shown.ts`.
  // The rail's Activity view (`rail/view/activity-view.tsx`), its heading,
  // session options menu and filter cycle (`rail/view/sessions-heading.tsx`)
  // and the row navigation both views share (`rail/view/row-navigation.ts`)
  // are renderer views over the session list, and the list reads a settled
  // row a turn end returns through `session/list/turn-end-reads.ts`; they add
  // no package edge.
  // Wire reads decode through their parsers: git answers in
  // `server/wire/git.ts` and the usage summary in `server/wire/usage.ts`; the
  // workbench and plugin panes check stored pane state with `shell/json.ts` and
  // adapt a typed pane kind through `shell/pane-kind-entry.tsx`. They add no
  // package edge.
  // Settings → Models' Sandbox group (owner: the accounts domain's sandbox
  // provider keys) reads and writes the keys through `server/sandbox-keys.ts`
  // and `server/wire/sandbox-keys.ts`, keeps their activity in
  // `accounts/sandbox-store.ts`, and draws them from
  // `accounts/view/sandbox-section.tsx`, `sandbox-key-row.tsx` and
  // `sandbox-key-form.tsx`. They add no package edge.
  // The new-session row's Where chip (owner: the projects domain) groups the
  // draft's placements in `projects/draft-where.ts` and draws them from
  // `projects/view/where-chip.tsx`, creating a cloud workspace through the shared
  // `new-cloud-workspace-dialog.tsx`; its Project chip creates a project in
  // `projects/view/create-project-dialog.tsx`; the Browser tab refuses another
  // machine's localhost in `browser/view/elsewhere-page.tsx`. They add no
  // package edge.
  // The one notice slot above the composer (owner: the composer domain) ranks
  // its notices in `composer/view/notice-slot.ts`; a draft's first send is its
  // machine in `session/view/first-send.ts` and its notice in
  // `session/view/first-send-notice.ts`; a placement's lifecycle notice in
  // `session/view/placement-notice.tsx` replaces the four `workspace-sleep/`
  // cards; the workbench matches a pane by route in `workbench/route-match.ts`.
  // They add no package edge.
  // Settings on the shared surfaces (owner: the app's settings domains): the
  // signed person's memberships and members (`server/organizations.ts`,
  // `server/wire/organizations.ts`, `server/access-types.ts`), the one form
  // dialog and drawer (`ui/controls/form-surface.tsx`), the integration connect
  // dialog (`settings/view/connect-dialog.tsx`), Usage's Cloud view
  // (`usage/view/cloud-usage.tsx`) and a project's Where it runs list, its new
  // cloud workspace dialog and environment drawer (`projects/view/where-it-runs.tsx`,
  // `new-cloud-workspace-dialog.tsx`, `project-environment-drawer.tsx`) replace
  // the cloud domain's section, row and inline create form, the placement list
  // and the inline connect form. They add no package edge.
  // The shell's loading and sign-in surfaces (owner: the app's shell, auth and
  // kit domains): the one placeholder bar (`ui/controls/skeleton.tsx` and its
  // stylesheet), the artwork plate shared by onboarding and sign-in
  // (`ui/controls/artwork-plate.tsx` and its stylesheet), the two-column
  // sign-in layout (`auth/view/auth-split.tsx`), the on-demand view helper the
  // split routes load through (`lib/lazy-view.ts`), and the auth store's read
  // of the last signed-in user for the startup restore (`auth/persistence.ts`,
  // which the renderer did not reach before). They add no package edge.
  // The new-session flow (owner: the app's projects, cloud and browser
  // domains): the create-project dialog (`projects/view/create-project-dialog.tsx`)
  // replaces the inline new-cloud-workspace panel, and the note a localhost
  // link from another machine's workspace opens (`browser/view/elsewhere-page.tsx`).
  // They add no package edge.
  // Product telemetry (owner: the app's server adapter and session requests):
  // the one sender of product events (`server/telemetry.ts`), the allowlisted
  // event contract it sends (`@claxedo/account-contract/product-events`, a
  // package the renderer already reaches) and the permission reply's event
  // (`session/requests/permission-decided.ts`). They add no package edge.
  // The Marketplace's one harness label for its install sheet and plugin
  // facts (owner: the app's marketplace domain): `marketplace/view/harness-label.ts`.
  // It adds no package edge.
  // Review round 1 (owner: the app's server adapter, shell, rail, composer and
  // session list): the workspace's own name decoded by the wire
  // (`server/wire/workspace-name.ts`), the
  // per-user state scope (`shell/principal-scope.ts`), home's no-placement
  // action (`shell/view/home-empty.tsx`), the rail's machine marker
  // (`rail/session-marker.ts`), the picker's empty-model states
  // (`composer/view/models-empty.ts`) and a new session's first-words title
  // (`session/list/pending-title.ts`). They add no package edge.
  // Review round 2 (owner: the app's cloud and marketplace domains): the
  // reader-language name of a cloud workspace with no name of its own
  // (`cloud/view/workspace-name.ts`) and the Marketplace's project-scope copy
  // by sign-in state (`marketplace/view/project-scope.ts`). They add no
  // package edge.
  // The picker's answer for a harness this cloud provider cannot run, with
  // the Pi alternative that spends the same account (owner: the app's
  // composer, `composer/view/harness-unavailable-here.ts`). It adds no
  // package edge.
  // A project's environment, write-only values listed by name through the
  // hosted or local route (owner: the app's server adapter,
  // `server/project-environment.ts`). It adds no package edge.
  // 1349/36, no headroom.
  ceilings: { modules: 1349, packages: 36 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-local.json",
    minModules: 700,
    minChunks: 1,
    requiredModules: [`${DESKTOP}/renderer/main.tsx`, `${APP}/app.tsx`, `${APP}/auth/electron-binding.ts`],
    forbiddenModules: [`${APP}/auth/better-auth-binding.ts`],
    forbiddenChunkMarkers: ["vendor-better-auth"],
  },
}
