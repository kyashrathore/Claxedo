import type { Policy } from "../policy.ts"
import { APP_ALIASES, MANIFEST_READS } from "./shared.ts"

const DESKTOP = "packages/claxedo-desktop/src"
const APP = "packages/claxedo-app/src"

/**
 * The desktop is a COMPOSITION artifact, so its boundary is stated as two
 * closures rather than one.
 *
 * Electron main and the renderer are separate processes with opposite rules,
 * and collapsing them into one policy is what makes a desktop boundary check
 * meaningless: main is SUPPOSED to hold the account adapter and the Host
 * Connector — it owns the machine key and the OAuth flow — while the unsigned
 * renderer must hold neither.
 */

/**
 * Electron main, unsigned build.
 *
 * The plan's wording is that the desktop account closure "explicitly permits
 * Electron main's account adapter". So `src/main/account/**` (10 modules) and
 * `src/main/host-connector/**` (4 modules) are reached from
 * `src/main/index.ts` and that is correct — they are the privileged side of the
 * IPC seam, and moving them out of main would put the machine private key in
 * the renderer.
 *
 * What main must never hold is the OTHER product's implementation: the browser
 * identity SDK, the hosted control plane, or the app's authenticated-identity
 * subpath. `hosted-operations.ts` is the account adapter's exhaustive handler
 * map — it attaches the bearer itself and never takes one from the renderer —
 * so a `@clerk/clerk-js` edge here would mean the browser SDK had been pulled
 * into a Node process that cannot run it.
 */
export const desktopAccountComposition: Policy = {
  id: "desktop-account-composition",
  summary: "@claxedo/desktop Electron main composition (src/main/index.ts)",
  packageDir: "packages/claxedo-desktop",
  entry: `${DESKTOP}/main/index.ts`,
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
  ],
  forbiddenModules: [
    // The renderer is a different process with a different module system.
    // A main-process import of renderer source would bundle DOM code into Node.
    `${DESKTOP}/renderer`,
  ],

  control: {
    minModules: 40,
    requiredModules: [
      `${DESKTOP}/main/index.ts`,
      // The permitted-but-load-bearing halves. If the walk lost these, every
      // "main holds no hosted code" answer below would be vacuous.
      `${DESKTOP}/main/account/index.ts`,
      `${DESKTOP}/main/account/hosted-operations.ts`,
      `${DESKTOP}/main/host-connector/index.ts`,
      // The window/product-mode decision, reached only through main's own
      // relative graph.
      `${DESKTOP}/main/navigation-guard.ts`,
    ],
    // Main owns the connector process and the Electron surface. Both absent
    // means the walk read no bare specifier at all.
    requiredPackages: ["@claxedo/host-connector", "electron"],
  },

  ceilings: { modules: 56, packages: 21 },
}

/**
 * The UNSIGNED desktop renderer.
 *
 * `index.tsx` is the signed entry; `local.tsx` is this one. The difference is
 * not a flag, and that is the lesson the whole split is built on — a single
 * entry with `if (signedBuild)` still ships the identity provider, because the
 * import graph does not care whether the branch runs.
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
 * NOT covered: this is the SOURCE graph. The desktop has no emitted-artifact
 * scan equivalent to `check-local-bundle-identity.ts` — see the note in
 * `verify.ts`.
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

  ceilings: { modules: 886, packages: 62 },
}
