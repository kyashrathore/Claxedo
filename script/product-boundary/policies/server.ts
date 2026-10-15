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
  // The D1 workspace authority's refusal type, its owner identity and
  // bootstrap-claim helpers and the statements it creates a workspace with are
  // modules of their own (`authority/adapters/d1/workspace-authority-error.ts`,
  // `owner-identity.ts`, `workspace-creation.ts`).
  // The machine session-row ingest finds who hears a changed session's status
  // through its own module (`authority/adapters/d1/session-status-notices.ts`),
  // and the live-sync room admits a publisher's nudge through
  // `deployments/hosted-workerd/live-sync-admission.ts` and writes its
  // replay-gap frame from `live-sync-replay-gap.ts`. A reader's seen and
  // settled marks are written by `session/routes/session-reader.ts` into the
  // D1 `session_reads` store (`authority/adapters/d1/session-reader-store.ts`).
  // Hosted account setup mounts the shared credential routes over the per-org
  // stores (`credentials/worker/routes.ts`, `org-routed.ts`). The cloud
  // workspace create refuses a branch git would refuse through
  // `workspace/git-branch-name.ts`.
  // A Pi session on a cloud workspace is served by its own Durable Object:
  // the plane resolves and admits that host (`authority/session-hosts.ts`),
  // mints its connection (`connections/session-host-connection.ts`) and
  // answers its per-turn delivery and execution calls and its delete
  // (`routes/session-host-delivery.ts`), whose D1 statement is a module of
  // its own (`authority/adapters/d1/hosted-session-delete.ts`); the session
  // authority's request parsing (`session/runtime-authority-request.ts`) and the D1 session
  // tables' row shapes (`authority/adapters/d1/session-rows.ts`) are modules
  // of their own. A reservation places its session by the creator's default
  // harness when it names none (`session/default-session-harness.ts`), and a
  // session host and an enrolled owner's machine are both handed the owner's
  // Pi accounts by one owner (`credentials/direct-rows.ts`). The session
  // authority's signed proofs, its leases and the relay's host tokens, are
  // minted and read in one module (`session/runtime-session-proofs.ts`).
  // The plane is the one refresher of a ChatGPT plan it hands over as its
  // token (`credentials/store-renewal.ts`), and a cloud sandbox renews that
  // plan mid-turn through `routes/runtime-credential-refresh.ts`, proven by
  // the turn lease check it shares with connection secrets
  // (`session/turn-lease-authority.ts`); both of a sandbox's secret routes are
  // served by the `routes/runtime-sandbox-secrets.ts` router. After it
  // provisions a cloud runtime the plane takes the start phases that runtime
  // timed in its sandbox (`workspace/runtime-start-phases.ts`).
  // +4 modules (owner: the hosted sandbox manager composition): an
  // organization's own sandbox provider key provisions its new workspaces.
  // `sandbox/org-sandbox-drivers.ts` picks the org's key or the operator's
  // driver, `sandbox/org-sandbox-manager.ts` routes each workspace's lifecycle
  // to the key its lease records, and the D1 plane keeps the org's chosen
  // driver (`sandbox/stores/d1-org-driver.ts`) behind the shared credential
  // routes' key policy (`sandbox/hosted-sandbox-driver-keys.ts`). None of
  // them imports a sandbox provider.
  // +2 modules (owner: the hosted workspace router): the owner deletes a cloud
  // workspace through `workspace/cloud-workspace-deletion.ts`, which destroys
  // its sandbox before the row, and the D1 deletion statements are a module of
  // their own (`authority/adapters/d1/workspace-deletion.ts`).
  // +1 module (owner: the hosted shell's provider catalog route): the OpenCode
  // catalog joins the caller's selected D1 accounts with the workspace engine's
  // catalog in `credentials/worker/opencode.ts`.
  // +1 package (owner: the hosted shell's Pi catalog and Pi draft options
  // route): `@earendil-works/pi-ai`, reached only through
  // `@claxedo/harness/pi-catalog`, the launch catalog the session host runs Pi
  // with, so the plane lists a connected provider's models and answers a Pi
  // draft on a cloud workspace without the workspace.
  // +2 modules (owner: the D1 workspace and host-access authorities): the
  // devices surface's listing of a person's machines by enrollment id
  // (`authority/adapters/d1/host-assignment-devices.ts`) and a workspace row's
  // shape and JSON with its repository connection
  // (`authority/adapters/d1/workspace-row-json.ts`), split from their
  // authorities.
  // +2 modules (owner: the session-host turn routes and the first-party MCP
  // endpoint): the per-turn MCP bearer of a session served by its own host
  // (`mcp/session-mcp-credentials.ts`) and the machine token its tools and the
  // turn's tools both mint (`authority/session-host-machine-access.ts`).
  // +1 module (owner: the D1 core authority composition): application-identity
  // admission, which maps a verified sign-in to a canonical user and human
  // actor, is its own module (`authority/adapters/d1/application-identity.ts`),
  // split from the workspace authority.
  // +1 module (owner: the D1 session authority): granting, moving, revoking
  // and listing a session's shares is its own module
  // (`authority/adapters/d1/session-shares.ts`), split from the session
  // authority, lent its database, clocks and access checks.
  // +2 modules, +1 package (owner: the hosted core app): every response names
  // the request's database and Durable Object time in Server-Timing
  // (`platform/http/server-timing.ts`) over the observed databases
  // (`platform/db/observed-d1.ts`); the ledger follows the request through
  // `node:async_hooks`, under the Worker's nodejs_compat.
  // +1 module (owner: the D1 usage ledger): a person's cloud machine time is
  // read from the boots the D1 lease store records, and both sides of the
  // `sandbox_boots` table live in `sandbox/stores/d1-boots.ts`. It imports no
  // sandbox provider.
  // +1 module net (owner: the hosted core app and the D1 usage ledger): the
  // usage-limits view reads each stored account's vendor before answering
  // (`usage/hosted-quota.ts` over `usage/quota-accounts.ts`, replacing the
  // machine reader `usage/quota.ts` and its bell), and the machine-time answer
  // is priced by the published rates beside the driver catalog
  // (`usage/machine-time-pricing.ts` over `sandbox-manager/driver-billing.ts`),
  // which is data and reaches no sandbox provider.
  // +3 modules, +1 package (owner: the hosted egress broker composition,
  // `credentials/hosted-egress-broker/`): a cloud sandbox whose driver has no
  // provider edge spends its owner's model accounts through the plane's own
  // broker at `/bindings/*` — the mount and account binder (`index.ts`), the
  // store-backed binding authority (`authority.ts`) and the placeholder pass
  // (`placeholder.ts`) — over `@claxedo/egress-broker`, the request policy and
  // header injection the desktop's loopback broker runs on. A driver with its
  // own edge never passes through it.
  // +1 module (owner: the hosted core app): the browser origins the plane
  // admits and the CORS it stamps for them, with the broker's carve-out, are
  // their own module (`deployments/hosted-shared/hosted-core-origins.ts`),
  // split from the core app.
  // +3 modules: a session served by its own Durable Object publishes its list
  // row under its turn lease, admitted by `session/session-host-rows.ts` (owner:
  // the session-rows ingest), and reports a vendor's refusal of a stored account
  // through `/turn-credential-refused`, judged by
  // `credentials/credential-refusals.ts` (owner: the session-host turn routes),
  // the one rule the hosted broker's own refusals go through too; and the one
  // idle policy every cloud sandbox stops under, `sandbox/workspace-idle.ts`
  // (owner: the hosted runtime delivery), which the provisioner's idle watch
  // applies over the relay for a driver whose host reads no idleness (Boat) and
  // the Cloudflare sandbox Worker bundles from the same file; it imports nothing.
  // +1 module (owner: the runtime session authority routes): a cloud
  // runtime's usage report is its own module (`usage/runtime-usage-report.ts`),
  // split from `routes/runtime-session-authority.ts`.
  // +1 module (owner: the hosted connection routes): the one provisioning
  // connection answer the connect and the read both give, with the start
  // phases the lease has recorded and the server's own elapsed times
  // (`connections/cloud-start-progress.ts`). It imports types alone.
  // +1 module (owner: the workspace routes and the session-host turn routes):
  // the one start of a cloud workspace's machine, `workspace/cloud-workspace-start.ts`,
  // split from the connect path so a session host's tool call starts the
  // machine through it as the workspace's owner.
  // +1 module (owner: the hosted workspace create route): the connection a new
  // cloud workspace's repository is read through, picked or found for a pasted
  // GitHub URL, `workspace/repository-connection.ts`. It adds no package edge.
  // +1 module (owner: the D1 session authority): the account a cloud turn's
  // usage is filed under, `authority/adapters/d1/cloud-turn-usage-owner.ts`,
  // split from `session-authority.ts` when it came to refuse a deleted
  // session as well as a deleted workspace.
  // 171/22, no headroom.
  ceilings: { modules: 171, packages: 22 },

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
