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
  // (`authority/adapters/d1/host-access-errors.ts`); auth email, invitations
  // included, leaves through the Worker's Cloudflare `EMAIL` binding
  // (`platform/auth/auth-email-delivery.ts`); the session authority
  // routes resolve whose connections a turn spends through
  // `connections/turn-owner.ts`, the owner of turn credential attribution, and
  // answer a decision the authority threw through
  // `session/runtime-authority-errors.ts`; the
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
  // `documents/relay-http.ts`). The hosted runtime delivery asks a workspace's
  // recorded backing before it provisions a sandbox for it
  // (`workspace/cloud-root-backing.ts`), so a machine-placed workspace gets none.
  // The D1 workspace authority's refusal type and its owner identity and
  // bootstrap-claim helpers are modules of their own
  // (`authority/adapters/d1/workspace-authority-error.ts`, `owner-identity.ts`).
  // The machine session-row ingest finds who hears a changed session's status
  // through its own module (`authority/adapters/d1/session-status-notices.ts`),
  // and the live-sync room admits a publisher's nudge through
  // `deployments/hosted-workerd/live-sync-admission.ts` and writes its
  // replay-gap frame from `live-sync-replay-gap.ts`. A reader's seen and
  // settled marks are written by `session/routes/session-reader.ts` into the
  // D1 `session_reads` store (`authority/adapters/d1/session-reader-store.ts`).
  // The statements that create a workspace live in
  // `authority/adapters/d1/workspace-creation.ts`. Hosted account setup mounts
  // the shared credential and provider-login routes over the per-org stores
  // (`credentials/worker/routes.ts`, `org-routed.ts`) with the D1 store a device
  // login waits in across instances (`provider-auth-pending.ts`).
  ceilings: { modules: 128, packages: 19 },

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
