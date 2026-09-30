import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-server/src"
const ENTRY = `${SRC}/deployments/hosted-workerd/better-auth-d1-worker.cf.ts`

/**
 * `@claxedo/server` ships to Cloudflare only. The plain Better Auth D1 Worker
 * is the entry whose graph `build:workerd-boundary` records as
 * `server-workerd.json`, because it composes the whole hosted core; the Agent
 * Plugins entries are measured by `src/deployments/deployment-closures.test.ts`.
 *
 * Every forbidden name below is something the workerd runtime cannot load or
 * a product that belongs on the user's machine: a Worker that reached one
 * would bundle and then fail at its first request.
 */
export const serverWorkerd: Policy = {
  id: "server-workerd",
  summary: "@claxedo/server Cloudflare Worker (src/deployments/hosted-workerd/better-auth-d1-worker.cf.ts)",
  packageDir: "packages/claxedo-server",
  entry: ENTRY,
  roots: [SRC],

  forbiddenPackages: [
    "electron",
    "@claxedo/desktop",
    "@claxedo/local-server",
    "better-sqlite3",
    "@lydell/node-pty",
    "@hono/node-server",
    "@hono/node-ws",
  ],
  forbiddenModules: [
    `${SRC}/deployments/self-hosted-node`,
    `${SRC}/authority/adapters/sqlite`,
    "packages/claxedo-local-server",
  ],

  control: {
    minModules: 50,
    requiredModules: [
      ENTRY,
      `${SRC}/deployments/hosted-workerd/core-worker.cf.ts`,
      `${SRC}/deployments/hosted-shared/hosted-core-app.ts`,
    ],
    requiredPackages: ["better-auth", "hono", "@claxedo/server-core"],
  },
  // The D1 authority composes its organization, team and project-member
  // modules beside `project-role.ts`, the one rank query they and every other
  // D1 reader share (`authority/adapters/d1/core-authority.ts`).
  ceilings: { modules: 104, packages: 20 },

  emitted: {
    file: "packages/claxedo-server/.artifacts/u8-package-split/manifests/server-workerd.json",
    minModules: 1_200,
    minChunks: 1,
    requiredModules: [
      ENTRY,
      `${SRC}/deployments/hosted-workerd/core-worker.cf.ts`,
      `${SRC}/deployments/hosted-shared/hosted-core-app.ts`,
    ],
  },
}
