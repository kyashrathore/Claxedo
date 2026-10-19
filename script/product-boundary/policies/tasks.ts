import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-tasks/src"

/**
 * The Tasks plugin's app entry: the code the host ships as the bundled
 * first-party plugin (`claxedo-app/vite.plugin-bundles.ts` builds it with
 * `@claxedo/plugin-build`) and runs in the app's realm on the desktop and in
 * the sandboxed frame on the web. `@claxedo/plugin-api` is a package edge
 * because the bundle resolves it from the plugin runtime global, never from
 * its own copy. Nothing of the Tasks server, storage or MCP tools may ride
 * along: they belong to the daemon and the Worker.
 */
export const tasksApp: Policy = {
  id: "tasks-app",
  summary: "@claxedo/tasks app entry (src/app/index.ts)",
  packageDir: "packages/claxedo-tasks",
  entry: `${SRC}/app/index.ts`,
  roots: [SRC],

  forbiddenPackages: [
    "@claxedo/app",
    "@claxedo/server",
    "@claxedo/local-server",
    "@claxedo/server-core",
    "@claxedo/mcp",
    "hono",
    "drizzle-orm",
    "better-sqlite3",
  ],
  forbiddenModules: [`${SRC}/http`, `${SRC}/mcp`, `${SRC}/stores`],

  control: {
    minModules: 3,
    requiredModules: [`${SRC}/app/index.ts`, `${SRC}/app/tool-cards.ts`, `${SRC}/app/presets/program.ts`, `${SRC}/app/page/program.ts`],
    requiredPackages: ["@claxedo/plugin-api"],
  },

  // The entry, its card templates, its dictionary and words, the cursor paging
  // (`app/paging.ts`) both surfaces list presets with, the surface sync
  // and parts every Tasks surface draws with, Settings → Presets
  // (`app/presets/`) and the Tasks page (`app/page/`). Both read the server
  // through the kit's own client and decoders (`client/client.ts`,
  // `decode.ts`, `contracts.ts`, `validation.ts`); Presets refuses a cloud Pi
  // preset with the kit's reason (`presets/model.ts`), and the page takes the
  // attachment types from `attachments.ts` and the next attempt from the
  // kit's start rules (`start.ts`, with its `errors.ts` and `hash.ts`).
  // Packages: the plugin API and `solid-js` (both provided by the plugin
  // runtime; the page watches the host's project list with a Solid effect),
  // `@claxedo/helpers` (the client's guards) and
  // `@claxedo/agent-runtime-contract` (harness labels and cloud hosts).
  // Measured, no headroom.
  ceilings: { modules: 50, packages: 4 },
}
