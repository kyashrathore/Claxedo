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
    requiredModules: [`${SRC}/app/index.ts`, `${SRC}/app/tool-cards.ts`],
    requiredPackages: ["@claxedo/plugin-api"],
  },

  // The entry, its card templates and its dictionary; the plugin API is the
  // one package. Measured, no headroom.
  ceilings: { modules: 3, packages: 1 },
}
