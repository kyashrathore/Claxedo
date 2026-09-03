# Desktop hosted-operation matrix

Status: **reviewed baseline**. Enforced by
`packages/claxedo-app/src/architecture/hosted-operation-inventory.test.ts`.

## Why this document exists

After the split, a signed desktop reaches Hosted Server through Electron main.
The renderer holds no bearer token, so every authenticated call has to cross an
IPC boundary. There is exactly one wrong way to build that boundary and it is
the obvious way: expose `invoke("hostedFetch", { url, method, body })` and let
the renderer keep calling what it calls today.

That is a confused deputy. Electron main holds the account credential; a
renderer compromise would then be able to spend it on any Hosted Server route,
including ones no product surface uses. The IPC surface must therefore be a
closed set of **named operations** with fixed method and path owned in main —
and a closed set can only be reviewed if it is written down first.

This is that list. A hosted contribution that calls something absent here
fails the inventory gate.

## What is deliberately NOT an account operation

Workspace **Runtime** traffic — HTTP, SSE, and WebSocket after a connection
mint — does not cross the account port. The signed client asks Hosted Server for
a connection (that call *is* in the matrix), then talks to Workspace Relay
directly using the short-lived Runtime Access Token in that response. Relay is
the data plane; Hosted Server is not a byte proxy and Electron IPC is not one
either.

The one-time user-deployed owner claim is also browser-only. The operator-facing
`app/routes/bootstrap-owner.tsx` sends the claim from a transient password input
to the fixed `POST /api/claxedo/auth/bootstrap-owner` route using the browser's
same signed session. It is deliberately absent from Electron's account port:
desktop is not an initial deployment-owner provisioning surface, and main must
never receive or retain this one-use secret.

Two consequences worth stating plainly:

- Tunnelling Runtime bytes through Electron IPC would serialize every terminal
  keystroke and token through the main process. It would also put a second
  credential path in front of traffic that already has one.
- `userHostedConnectionInfo` intentionally returns `relayUrl` and no
  `directRuntimeUrl`. The laptop is never a direct client target, so no matrix
  row may return a laptop address.

Also excluded from AccountPort (intentional non-rows):

- **Workspace-scoped** `GET /api/wr/events` after connection mint — RAT data
  plane (same as other post-mint runtime traffic). The **central** control-plane
  bus is `session.events` below.
- **Sandbox driver** routes (`GET|PUT /api/workspace/drivers*`) — local sidecar
  only; signed hosted sessions may view them through the local proxy but do not
  spend the Hosted Server bearer on them.
- **Machine pause / second-device-open** — desktop reaches these through Host
  Connector IPC; browser self-hosted uses the page session over HTTP. The
  enrollment handshake itself is the `host.enroll*` rows below, and
  request / enroll / heartbeat are Host-Connector-child rows in the machine
  remote access section.
- **Retired** `GET /documents/events` — editors now use the central
  `session.events` doorbell.

## Transport kinds

| Kind | Meaning | Electron handler obligation |
|---|---|---|
| `unary` | One request, one decoded result. | Return the decoded value. Never the raw `Response`, never the token. |
| `stream` | Server-sent events consumed until cancelled. | Own the stream handle and its cleanup; forward decoded events; cancel on renderer disconnect. |
| `upload` | Request body is a file/blob. | Stream the body; do not buffer it into an IPC message. |
| `websocket` | Bidirectional session. | Own the socket lifetime; close it when the owning surface unmounts. |

## Retry and idempotency

`safe` means the operation may be retried after an uncertain delivery.
`idempotency-key` means retry is safe only when the caller replays the same
key. `unsafe` means an uncertain result must be surfaced, never silently
retried — a duplicate here creates a duplicate workspace, charge, or document.

**There is no client-side idempotency-key mechanism today, and the desktop
cannot grow one on its own.** `claxedo-desktop/src/main/account/hosted-operations.ts`
expresses a request as a method, a path template, and a list of declared body
fields; it has no header seam, and every route named below that accepts a key
accepts it as a body field its schema must declare. So an `idempotency-key` row
is only true when the ROUTE already carries the key, and each one says which
field that is. A row that named a key the route does not accept would be worse
than none: bodies are validated strictly, so the "safe retry" would 400 the
first attempt. Where no such field exists the row is classified `unsafe`, which
is the honest reading and the one a caller must act on.

## The matrix

Paths are Hosted Server route templates as mounted by `createHostedApp`
(`packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`), which
is the authoritative source for this column.

### Account and organization

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `account.mode` | `features/settings/ui/account-section.tsx` | `GET /api/claxedo/mode` | unary | safe | Deployment posture; drives which hosted surfaces render. |
| `account.compatibility` | `app/boot/data/bootstrap-orchestrator.ts` | `GET /api/claxedo/compatibility` | unary | safe | Client/server version gate. |
| `account.cliExchange` | `app/routes/cli-login-token.ts` | `POST /api/auth/cli/exchange` | unary | unsafe | Mints a CLI session token. A replayed exchange must not mint twice, and nothing stops it: the route mints from the bearer and never reads the request body, so each call is a fresh separately-revocable pair. Refused to the renderer entirely (`RENDERER_WITHHELD_OPERATIONS`), because the result is itself a credential. |
| `org.list` | `features/settings/data/org-team-api.ts` | `GET /api/control/orgs` | unary | safe | Orgs the signed caller belongs to; Settings + rail switcher. |
| `org.create` | `features/settings/data/org-team-api.ts` | `POST /api/control/orgs` | unary | unsafe | Creates an org (and usually a default team). A retried create is a duplicate org. |
| `org.teams.list` | `features/settings/data/org-team-api.ts` | `GET /api/control/orgs/:orgId/teams` | unary | safe | Teams for an org; Settings, rail switcher, and People "share with team" picker (also called from `session-share-api`). |
| `org.teams.create` | `features/settings/data/org-team-api.ts` | `POST /api/control/orgs/:orgId/teams` | unary | unsafe | Creates a team in an org. |
| `org.ensureDefaultTeam` | `features/settings/data/org-team-api.ts` | `POST /api/control/orgs/:orgId/ensure-default-team` | unary | unsafe | Ensures the org has a default team; may create one. |
| `team.members.list` | `features/settings/data/org-team-api.ts` | `GET /api/control/teams/:teamId/members` | unary | safe | |
| `team.members.add` | `features/settings/data/org-team-api.ts` | `POST /api/control/teams/:teamId/members` | unary | unsafe | |
| `team.members.remove` | `features/settings/data/org-team-api.ts` | `DELETE /api/control/teams/:teamId/members` | unary | unsafe | |
| `team.projects.grant` | `features/settings/data/org-team-api.ts` | `POST /api/control/teams/:teamId/projects` | unary | unsafe | Grants a project role to a team. |

### Workspace authority

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `workspace.list.cloud` | `features/workspaces/data/workspace-catalog.ts` | `GET /api/workspace?access=cloud` | unary | safe | The access kind is fixed in the path, not a parameter — see below. |
| `workspace.list.userHosted` | `features/workspaces/data/workspace-catalog.ts` | `GET /api/workspace?access=user-hosted` | unary | safe | The laptop rows. A caller wanting the whole picture runs both operations and merges, which is what `controlPlaneCatalog` already does. |
| `workspace.resolve` | `platform/runtime/workspace-runtime-record.ts` | `GET /api/workspace/resolve` | unary | safe | Optional query: `workspaceId`, `directory`, `create`. Desktop signed mode calls through AccountPort. |
| `workspace.create` | `features/workspaces/data/workspace-create-api.ts` | `POST /api/workspace/create` | unary | unsafe | Provisions a cloud VM. Without a key, an uncertain response creates a second VM — and there is no key to replay. `createCloudBody` in `claxedo-server/src/routes/hosted/workspace.ts` is `.strict()` with no idempotency field, so a key sent from a client 400s the whole request. Classified `unsafe` until the route accepts one; an uncertain response must be surfaced, never retried. Desktop signed mode calls this through AccountPort; browser keeps `api.post`. |
| `workspace.lifecycle` | `features/workspaces/actions/project-actions.tsx` | `POST /api/workspace/:id/lifecycle/:operation` | unary | unsafe | Stop/replace/cleanup/destroy. The route reads only `approved` and `checkpointId` and accepts no key. `stop`, `cleanup` and `destroy` converge on a state and tolerate a retry; `replace` provisions, so it does not — classified by its worst member. Every operation but `stop` refuses with 409 unless `approved: true` is in the body. |
| `workspace.checkpoints.list` | `features/workspaces/actions/project-actions.tsx` | `GET /api/workspace/:id/checkpoints` | unary | safe | |
| `workspace.checkpoints.create` | `features/workspaces/actions/project-actions.tsx` | `POST /api/workspace/:id/checkpoints` | unary | unsafe | Creates a checkpoint snapshot. |
| `workspace.checkpoints.restore` | `features/workspaces/actions/project-actions.tsx` | `POST /api/workspace/:id/checkpoints/:checkpointId/restore` | unary | unsafe | Destructive to working state. |
| `workspace.connection.mint` | `platform/runtime/agent/workspace-relay-connection.ts` | `GET /api/workspace/:id/connection` | unary | safe | Returns `relayUrl` plus a scoped Runtime Access Token, and no laptop address. Desktop signed mode calls through AccountPort (`id` path param). |
| `workspace.connection.refresh` | `platform/runtime/agent/workspace-relay-connection.ts` | `POST /api/workspace/:id/connection/refresh` | unary | safe | Called before expiry and after a Relay 401. Desktop signed mode calls through AccountPort (`id` + optional `previousJti`). |

**Why the workspace list is two operations.** `GET /api/workspace` with no
`?access=` is not a wider list: the hosted handler
(`claxedo-server/src/routes/hosted/workspace.ts`) requires a signed caller,
reaches the authority, and answers rows only when `access` is `cloud` or
`user-hosted`. Every other value — including absent — falls through to
`{ workspaces: [] }`. A single access-less `workspace.list` row therefore
returned an empty list for its whole life, which no test noticed because an
empty envelope decodes perfectly.

The fix could have been an `access` PARAMETER, and the desktop table could
express one: its `:name` substitution fills a query string as readily as a path
segment. It is two operations instead because nothing picks a kind at runtime —
the one caller wants both and merges them — and because the two properties this
document exists for are per-name. The set of requests main can make stays
readable in the table rather than depending on what the renderer passes, and
`RENDERER_WITHHELD_OPERATIONS` can withhold one access kind without withholding
the other. So where a row carries a query, that query is written out in full and
contains no `:name`; `hosted-operations.test.ts` enforces it.

### Machine remote access (user-hosted)

Unit 6 moves the laptop side of this into Host Connector. The rows below are the
**client** side that a signed desktop or browser still calls.

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `workspace.assignHost` | `src/main/host-connector/child-supervisor.ts` | `POST /api/workspace/:id/host-assignment` | unary | idempotency-key | The OWNER's declaration that this host serves the workspace — pure data, an upsert on workspace_id. No challenge and no machine signature: liveness is the enrollment lease and consent is the heartbeat's acked set; routing needs all three. **Main-only**: the host id must be THIS machine's, which only the supervisor knows, so `RENDERER_WITHHELD_OPERATIONS` refuses the account channel and the renderer's route is the data-only `claxedo.hostConnector.share` IPC. |
| `workspace.unassignHost` | `src/main/host-connector/child-supervisor.ts` | `DELETE /api/workspace/:id/host-assignment` | unary | safe | Withdraws the owner's assignment; routing refuses immediately (intent AND consent). Main-only for the same reason as assign. |
| `host.enrollCurrentMachine` | `platform/account/account-port.ts` | `POST /api/claxedo/host/enrollments` | unary | idempotency-key (`hostId`) | Enrolls the MACHINE once, with no workspace in the path — the successor of the retired per-workspace host-link registration. The key is the machine identity and it is a real one — `enrollForUser` patches the existing row for the same `host_id` rather than inserting a second. **Main-only.** `publicKey` and `signature` are the machine identity, so a caller that supplies them enrolls a machine whose private half main has never seen; the route stores whatever public key it is handed, and a second enrollment on a known `host_id` overwrites the honest key and clears a revocation. The only caller is Electron main's Host Connector, which fills those fields from the key it owns. The renderer's route to this feature is the connector's own zero-argument IPC (`claxedo.hostConnector.start`), and `RENDERER_WITHHELD_OPERATIONS` refuses the account channel. |
| `host.enrollmentNonce` | `platform/account/account-port.ts` | `POST /api/claxedo/host/enrollments/requests` | unary | unsafe | The one-use nonce the machine signs. Unsafe rather than safe: each call mints a new nonce, so a retry burns one. It carries no secret — the nonce is public and worthless without the machine's private key — but a caller that retried freely would fill the request table. Main-only, like the enrollment it precedes: a renderer able to mint nonces holds step one of the handshake, and the account channel is refused. |
| `host.enrollmentHeartbeat` | `platform/account/account-port.ts` | `POST /api/claxedo/host/enrollments/heartbeat` | unary | safe | Presence AND consent, signed by the machine key: the v2 payload covers the served workspace set, the response returns the owner's assignment view for reconciliation plus ONE Host Tunnel credential for the assigned∩acked set. Safe to retry only by RE-SIGNING — every signature hash is single-use at the authority. A REJECTED beat is not retried at all — the connector stops, because re-enrolling would be it overruling a revocation. Main-only: the signature is the machine key's. |

### Sessions

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `session.list` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/control/sessions` | unary | safe | Flat inventory for a workspace. |
| `session.navigationList` | `features/session/data/query/session-list.ts` | `GET /api/control/session-list` | unary | safe | Paginated rail rows; declared query keys only (`scope`, `limit`, plus optional filters). |
| `session.create` | `platform/runtime/cloud/workspace-runtime-store.ts` | `POST /api/control/sessions` | unary | unsafe | A retried create is a duplicate session. Prompt admission is never repeated on transport loss. |
| `session.messages` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/control/sessions/:sessionId/messages` | unary | safe | |
| `session.gateway` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/control/sessions/:sessionId/gateway` | unary | safe | |
| `session.projection.register` | `platform/runtime/agent/session-projection.ts` | `POST /api/control/workspaces/:workspaceId/sessions/:sessionId/register` | unary | unsafe | Sync-back into Convex; body carries `idempotencyKey`. |
| `session.projection.checkpoint` | `platform/runtime/agent/session-projection.ts` | `POST /api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint` | unary | unsafe | |
| `session.projection.repair` | `platform/runtime/agent/session-projection.ts` | `POST /api/control/workspaces/:workspaceId/sessions/:sessionId/repair` | unary | unsafe | |
| `session.events` | `app/integrations/claxedo-events.tsx` | `GET /api/wr/events` | stream | safe | Central control-plane SSE (not workspace-scoped RAT traffic). Resumes via declared `Last-Event-ID` header param. Provisioning progress filters this same bus. |
| `session.runtimeEvents` | `app/providers/global-sdk/provider.tsx` | `GET /api/control/session/:sessionId/runtime-events` | stream | safe | Central per-session runtime SSE; `parentSessionId` is a required declared query key. Workspace-scoped `/api/wr/runtime-events` after mint stays on the RAT data plane. |
| `session.shares.list` | `features/session/data/session-share-api.ts` | `GET /api/control/sessions/:sessionId/shares` | unary | safe | `workspaceId` is a declared query parameter (not a free-form `:name` in the path). |
| `session.shares.grant` | `features/session/data/session-share-api.ts` | `POST /api/control/sessions/:sessionId/shares` | unary | unsafe | Grants private-session visibility to a person, team, or org. |
| `session.shares.revoke` | `features/session/data/session-share-api.ts` | `DELETE /api/control/sessions/:sessionId/shares` | unary | unsafe | |
| `session.participants.add` | `features/session/data/session-share-api.ts` | `POST /api/control/sessions/:sessionId/participants` | unary | unsafe | |

### WorkGraph

WorkGraph's client takes its transport by injection
(`createWorkGraphClient({ request })`). Today `app/integrations/doc-workgraph.ts`
injects `authFetch` directly. The injection seam is what lets a signed desktop
rebind that client onto the Electron operation port without rewriting every
WorkGraph call site.

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `workgraph.snapshot` | `features/workgraph/api.ts` | `GET /api/workgraph/snapshot` | unary | safe | Paged; the client aggregates pages. |
| `workgraph.command` | `features/workgraph/api.ts` | `POST /api/workgraph/commands` | unary | idempotency-key | Carries a client-generated `operationId`; that key is the replay guard. |
| `workgraph.read` | `features/workgraph/api.ts` | `GET /api/workgraph/*` | unary | safe | Attention, evidence, runs, activity, defaults, capabilities. |
| `workgraph.write` | `features/workgraph/api.ts` | `POST /api/workgraph/*` | unary | idempotency-key | Same `operationId` contract as `workgraph.command`. PUT/DELETE selected via declared `httpMethod` parameter (POST\|PUT\|DELETE only). |

### Documents

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `documents.list` | `features/documents/data/documents-api.ts` | `GET /documents` | unary | safe | |
| `documents.get` | `features/documents/data/documents-api.ts` | `GET /documents/:id` | unary | safe | |
| `documents.create` | `features/documents/data/documents-api.ts` | `POST /documents` | unary | unsafe | |
| `documents.update` | `features/documents/data/documents-api.ts` | `PATCH /documents/:id` | unary | safe | |
| `documents.content.get` | `features/documents/data/documents-api.ts` | `GET /documents/:id/content` | unary | safe | |
| `documents.content.put` | `features/documents/data/documents-api.ts` | `PUT /documents/:id/content` | upload | unsafe | Body is document content, not a JSON envelope. A `unary` handler here would buffer whole documents into IPC messages. |
| `documents.export` | `features/documents/data/documents-api.ts` | `GET /documents/:id/export` | unary | safe | Binary payload returned as `{ bytesBase64, contentType? }` over IPC (not a raw Response). |
| `documents.agentOpen` | `features/documents/data/documents-api.ts` | `POST /documents/:id/agent-open` | unary | unsafe | |
| `documents.runtimeConflictResolve` | `features/documents/data/documents-api.ts` | `POST /documents/:id/runtime-conflict/resolve` | unary | unsafe | |
| `documents.moveToRepository` | `features/documents/data/documents-api.ts` | `POST /documents/:id/move-to-repository` | unary | unsafe | |
| `documents.fromRepo` | `features/documents/data/documents-api.ts` | `POST /documents/from-repo` | unary | unsafe | |
| `documents.snapshots` | `features/documents/data/documents-api.ts` | `GET /documents/:id/snapshots` | unary | safe | |
| `documents.snapshots.restore` | `features/documents/data/documents-api.ts` | `POST /documents/:id/snapshots/:snapshotId/restore` | unary | unsafe | |
| `documents.workSource` | `features/documents/data/documents-api.ts` | `POST /documents/:id/work-source` | unary | safe | |
| `documents.workSourcePin` | `features/documents/data/documents-api.ts` | `POST /documents/:id/snapshots/:snapshotId/work-source-pin` | unary | safe | |
| `documents.statuses` | `features/documents/data/documents-api.ts` | `GET /documents/statuses` | unary | safe | |

### Connections and integrations

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `connections.list` | `features/settings/ui/connections.tsx` | `GET /api/claxedo/integrations` | unary | safe | |
| `connections.connect` | `features/settings/ui/connections.tsx` | `POST /api/claxedo/integrations/:id/connect` | unary | unsafe | Starts an OAuth attempt or key connect. |
| `connections.attempt` | `features/settings/ui/connections.tsx` | `GET /api/claxedo/integrations/attempts/:state` | unary | safe | |
| `connections.repositories` | `features/workspaces/ui/dialogs/repository-picker.ts` | `GET /api/claxedo/integrations/connections/:id/repositories` | unary | safe | |
| `connections.disconnect` | `features/settings/ui/connections.tsx` | `DELETE /api/claxedo/integrations/connections/:id` | unary | safe | |
| `connections.reverify` | `features/settings/ui/connections.tsx` | `POST /api/claxedo/integrations/connections/:id/reverify` | unary | unsafe | Re-checks stored credentials. |

### Provisioning and sandbox

Sandbox driver configuration (`/api/workspace/drivers*`) is local-sidecar-only —
see "What is deliberately NOT an account operation". Cloud create listens for
`provision` frames on `session.events` rather than opening a second stream.

### Billing

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `billing.checkout` | `features/settings/ui/account-section.tsx` | `POST /api/billing/checkout` | unary | unsafe | Returns a redirect target. A duplicate is a duplicate charge attempt. |
| `billing.portal` | `features/settings/ui/account-section.tsx` | `POST /api/billing/portal` | unary | safe | |

### Usage

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `usage.get` | `features/usage/data/usage-api.ts` | `GET /api/claxedo/usage` | unary | safe | Declared optional query keys only; filter_* dimensions are passed as optionalQuery entries named `filter_provider`, `filter_harness`, `filter_model`, `filter_location`, `filter_session`, `filter_workspace`, `filter_app`. |
| `usage.sync` | `features/usage/data/usage-api.ts` | `POST /api/claxedo/usage/sync` | unary | safe | |

### Agent config (extensions marketplace)

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `agentConfig.extensions.read` | `features/extensions/marketplace/panel.tsx` | `GET /api/claxedo/agent-config/extensions/*` | unary | safe | `subpath` may be empty (list) or a relative suffix (`catalog`, `machine-scan`, …). Declared optional query: `scope`, `directory`, `workspaceId`. |
| `agentConfig.extensions.write` | `features/extensions/marketplace/panel.tsx` | `POST /api/claxedo/agent-config/extensions/*` | unary | unsafe | Install/enable/disable/uninstall/adopt/ignore/detach. `httpMethod` selects POST\|PUT\|DELETE; body via `payload`. |

## Operations that are not yet platform-neutral

Unit 1 is allowed to conclude that an operation cannot be platform-neutral,
which blocks Unit 9 until it gets a typed broker contract. One remains flagged:

1. **`connections.connect` opens a system browser** and completes through a
   redirect back to the hosted origin. In the desktop composition there is no
   hosted origin to return to; the callback has to arrive through Electron's
   registered scheme and be dispatched to the waiting surface. This shares the
   OAuth callback machinery Unit 6 builds for account sign-in and must reuse it
   rather than adding a second callback path.

## Enforcement

`hosted-operation-inventory.test.ts` asserts:

1. Every module in `features/workgraph`, `features/documents`,
   `platform/runtime/cloud`, and the hosted subsets of `features/workspaces`,
   `features/settings`, `features/onboarding`, and `app/routes` that reaches
   authenticated transport is named as an owner in this file.
2. Every owner named here still exists and still reaches authenticated
   transport, so retired rows do not accumulate.
3. Every path in this file is a route the hosted app actually mounts, or is
   explicitly recorded as local-only.
4. No row claims a `directRuntimeUrl` or a laptop address.
