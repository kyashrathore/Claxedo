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
  // modules beside `authorization.ts`, the one owner of every D1 access rule
  // (`authority/adapters/d1/core-authority.ts`); the host access authority's
  // error contract is its own module
  // (`authority/adapters/d1/host-access-errors.ts`); the Better Auth
  // composition adds the AUTH_DB email lookup an org admin adds a member by
  // (`platform/auth/better-auth-d1-account-email.ts`); the session authority
  // routes resolve whose connections a turn spends through
  // `connections/turn-owner.ts`, the one owner the self-hosted node shares; the
  // D1 session authority's refusal error and input validation
  // (`authority/adapters/d1/session-input.ts`) are a module of their own; every
  // D1 adapter reads a constraint failure through `platform/db/d1-constraint.ts`;
  // the org, team and People routes share one typed refusal envelope
  // (`platform/http/public-api-error-response.ts`). Hosted
  // Pages are mounted by the core Worker: the D1 document authority
  // (`authority/adapters/d1/document-authority.ts`), the R2 documents backend
  // with its index and managed store (`documents/backends/hosted/`), and the
  // runtime broker that hydrates a page into a session
  // (`documents/backends/hosted/runtime-broker.ts` with its relay client
  // `documents/relay-http.ts`).
  ceilings: { modules: 116, packages: 19 },

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
