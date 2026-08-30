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
  // daemon-exit lifecycle owner; keep the ceiling exact.
  ceilings: { modules: 77, packages: 23 },
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

  ceilings: { modules: 15, packages: 6 },
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
  // Session markdown first-fold preload, environment-card persistence, Thinking
  // visibility hold, provider-settings detect/disconnect logic, models-settings
  // logic, provider setup row, and the settings-providers dialog opener add the
  // same eight named owners as app-local: 981 + 8 - 3 = 986 modules, no new
  // package edge.
  ceilings: { modules: 986, packages: 62 },
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
  control: {
    minModules: 250,
    requiredModules: [
      `${DESKTOP}/renderer/hosted-contributions.ts`,
      `${APP}/app/composition/hosted-contribution-loader.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access-binding.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access.ts`,
    ],
    requiredPackages: ["solid-js", "@claxedo/workgraph"],
  },
  // The hosted task composer now reaches the existing canonical config owner.
  ceilings: { modules: 299, packages: 40 },
  emitted: {
    file: "packages/claxedo-desktop/out/product-boundary/desktop-renderer-hosted-contributions.json",
    minModules: 500,
    minChunks: 50,
    requiredModules: [
      `${DESKTOP}/renderer/hosted-contributions.ts`,
      `${APP}/app/composition/hosted-contribution-loader.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access-binding.ts`,
      `${DESKTOP}/renderer/remote-access/electron-machine-remote-access.ts`,
    ],
  },
}
