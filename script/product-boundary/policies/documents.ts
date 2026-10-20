import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-documents/src"

/**
 * The Documents plugin's app entry: the code the host ships as the bundled
 * first-party plugin (`claxedo-app/vite.plugin-bundles.ts` builds it with
 * `@claxedo/plugin-build`). It registers the transcript cards for the
 * `documents_*` tools and nothing else; the Documents server, storage, runtime
 * hydration, MCP tools and CLI command belong to the hosts that compose them.
 */
export const documentsApp: Policy = {
  id: "documents-app",
  summary: "@claxedo/documents app entry (src/app/index.ts)",
  packageDir: "packages/claxedo-documents",
  entry: `${SRC}/app/index.ts`,
  roots: [SRC],

  forbiddenPackages: [
    "@claxedo/app",
    "@claxedo/server",
    "@claxedo/local-server",
    "@claxedo/server-core",
    "@claxedo/workspace-runtime",
    "@claxedo/mcp",
    "hono",
    "drizzle-orm",
    "better-sqlite3",
  ],
  forbiddenModules: [`${SRC}/host`, `${SRC}/hosted`, `${SRC}/local`, `${SRC}/runtime`, `${SRC}/mcp`, `${SRC}/cli`],

  control: {
    minModules: 3,
    requiredModules: [`${SRC}/app/index.ts`, `${SRC}/app/tool-cards.ts`, `${SRC}/app/dictionary.ts`],
    requiredPackages: ["@claxedo/plugin-api"],
  },

  // The entry, its card templates and its dictionary; the plugin API is the
  // one package, provided by the plugin runtime. Measured, no headroom.
  ceilings: { modules: 3, packages: 1 },
}
