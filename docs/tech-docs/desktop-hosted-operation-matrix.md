# Desktop hosted-operation matrix

Status: **reviewed baseline** (U8 Unit 1). Enforced by
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

This is that list. Unit 9 turns it into `hosted-operations.ts` (app-owned
request/result schemas), Unit 10 generates `required-hosted-operations.ts` from
it, and Unit 11 implements it as an exhaustive Electron handler map. A hosted
contribution that calls something absent here fails the inventory gate.

## What is deliberately NOT an account operation

Workspace **Runtime** traffic — HTTP, SSE, and WebSocket after a connection
mint — does not cross the account port. The signed client asks Hosted Server for
a connection (that call *is* in the matrix), then talks to Workspace Relay
directly using the short-lived Runtime Access Token in that response. Relay is
the data plane; Hosted Server is not a byte proxy and Electron IPC is not one
either.

Two consequences worth stating plainly:

- Tunnelling Runtime bytes through Electron IPC would serialize every terminal
  keystroke and token through the main process. It would also put a second
  credential path in front of traffic that already has one.
- `userHostedConnectionInfo` intentionally returns `relayUrl` and no
  `directRuntimeUrl`. The laptop is never a direct client target, so no matrix
  row may return a laptop address.

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

## The matrix

Paths are Hosted Server route templates as mounted by `createHostedApp`
(`packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`), which
is the authoritative source for this column.

### Account and organization

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `account.get` | `features/settings/ui/account-section.tsx` | `GET /api/claxedo/bootstrap` | unary | safe | Sanitized identity/org only. The renderer receives display state, never a token. |
| `account.mode` | `features/settings/ui/account-section.tsx` | `GET /api/claxedo/mode` | unary | safe | Deployment posture; drives which hosted surfaces render. |
| `account.compatibility` | `app/boot/data/bootstrap-orchestrator.ts` | `GET /api/claxedo/compatibility` | unary | safe | Client/server version gate. |
| `account.cliExchange` | `app/routes/cli-login-token.ts` | `POST /api/auth/cli/exchange` | unary | unsafe | Mints a CLI session token. A replayed exchange must not mint twice. |

### Workspace authority

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `workspace.list` | `features/workspaces/data/workspace-connection.ts` | `GET /api/workspace` | unary | safe | Includes both laptop and cloud-VM rows; placement is a field, not a route. |
| `workspace.resolve` | `features/workspaces/data/workspace-connection.ts` | `GET /api/workspace/resolve` | unary | safe | |
| `workspace.create` | `features/workspaces/ui/dialogs/create-cloud-project.tsx` | `POST /api/workspace/create` | unary | idempotency-key | Provisions a cloud VM. Without a key, an uncertain response creates a second VM. |
| `workspace.lifecycle` | `features/workspaces/actions/project-actions.tsx` | `POST /api/workspace/:id/lifecycle/:operation` | unary | idempotency-key | Start/stop/suspend. |
| `workspace.checkpoints.list` | `features/workspaces/actions/project-actions.tsx` | `GET /api/workspace/:id/checkpoints` | unary | safe | |
| `workspace.checkpoints.restore` | `features/workspaces/actions/project-actions.tsx` | `POST /api/workspace/:id/checkpoints/:checkpointId/restore` | unary | unsafe | Destructive to working state. |
| `workspace.connection.mint` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/workspace/:id/connection` | unary | safe | Returns `relayUrl` plus a scoped Runtime Access Token, and no laptop address. |
| `workspace.connection.refresh` | `platform/runtime/cloud/workspace-runtime-store.ts` | `POST /api/workspace/:id/connection/refresh` | unary | safe | Called before expiry and after a Relay 401. |

### Machine remote access (user-hosted)

Unit 6 moves the laptop side of this into Host Connector. The rows below are the
**client** side that a signed desktop or browser still calls.

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `hostLink.register` | `features/workspaces/data/share-workspace.ts` | `POST /api/workspace/:id/user-hosted/register` | unary | idempotency-key | Per-workspace registration. Unit 6 replaces it with one machine-wide enrollment; recorded here as the current producer. |
| `hostLink.challenge` | `features/onboarding/remote-access-controller.ts` | `POST /api/workspace/:id/user-hosted/challenge` | unary | unsafe | One-use nonce. |
| `hostLink.heartbeat` | `features/onboarding/remote-access-controller.ts` | `POST /api/workspace/:id/user-hosted/heartbeat` | unary | safe | Presence only. |
| `hostLink.pause` | `features/onboarding/remote-access-controller.ts` | `POST /api/workspace/:id/user-hosted/pause` | unary | safe | Idempotent by design; pausing twice is pausing. |
| `hostLink.secondDeviceOpen` | `features/onboarding/remote-access-marker.tsx` | `POST /api/claxedo/remote-access/workspaces/:workspaceId/second-device-open` | unary | safe | |
| `host.enrollCurrentMachine` | `platform/account/account-port.ts` | `POST /api/claxedo/host/enrollments` | unary | idempotency-key | Unit 6's replacement for `hostLink.register`: enrolls the MACHINE once, with no workspace in the path. Enrolling twice from the same machine must return the existing enrollment rather than a second one, so the key is the machine identity. The renderer names the operation and receives an enrollment record; the credential and the machine key stay in Electron main. |

### Sessions

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `session.list` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/control/sessions` | unary | safe | |
| `session.create` | `platform/runtime/cloud/workspace-runtime-store.ts` | `POST /api/control/sessions` | unary | unsafe | A retried create is a duplicate session. Prompt admission is never repeated on transport loss. |
| `session.messages` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/control/sessions/:sessionId/messages` | unary | safe | |
| `session.gateway` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/control/sessions/:sessionId/gateway` | unary | safe | |
| `session.events` | `app/integrations/claxedo-events.tsx` | `GET /api/claxedo/events` | stream | safe | Cursored SSE; resumes from `Last-Event-ID`, refetches after a replay gap. |
| `session.runtimeEvents` | `platform/runtime/cloud/workspace-runtime-store.ts` | `GET /api/wr/events` | stream | safe | |

### WorkGraph

WorkGraph's client takes its transport by injection
(`createWorkGraphClient({ request })`). Today `app/integrations/doc-workgraph.ts`
injects `authFetch` directly. Unit 11 replaces that injection with the Electron
operation port; the injection seam is what makes that a one-line change rather
than a rewrite of every WorkGraph call site.

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `workgraph.snapshot` | `features/workgraph/api.ts` | `GET /api/workgraph/snapshot` | unary | safe | Paged; the client aggregates pages. |
| `workgraph.command` | `features/workgraph/api.ts` | `POST /api/workgraph/commands` | unary | idempotency-key | Carries a client-generated `operationId`; that key is the replay guard. |
| `workgraph.read` | `features/workgraph/api.ts` | `GET /api/workgraph/*` | unary | safe | Attention, evidence, runs, activity, defaults, capabilities. |
| `workgraph.write` | `features/workgraph/api.ts` | `POST\|PUT\|DELETE /api/workgraph/*` | unary | idempotency-key | Same `operationId` contract as `workgraph.command`. |

### Documents

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `documents.list` | `features/documents/data/documents-api.ts` | `GET /documents` | unary | safe | |
| `documents.get` | `features/documents/data/documents-api.ts` | `GET /documents/:id` | unary | safe | |
| `documents.create` | `features/documents/data/documents-api.ts` | `POST /documents` | unary | unsafe | |
| `documents.update` | `features/documents/data/documents-api.ts` | `PATCH /documents/:id` | unary | safe | |
| `documents.content.get` | `features/documents/data/documents-api.ts` | `GET /documents/:id/content` | unary | safe | |
| `documents.content.put` | `features/documents/data/documents-api.ts` | `PUT /documents/:id/content` | upload | unsafe | Body is document content, not a JSON envelope. A `unary` handler here would buffer whole documents into IPC messages. |
| `documents.export` | `features/documents/data/documents-api.ts` | `GET /documents/:id/export` | upload | safe | Response is a binary/rich payload; must stream. |
| `documents.snapshots` | `features/documents/data/documents-api.ts` | `GET /documents/:id/snapshots` | unary | safe | |
| `documents.snapshots.restore` | `features/documents/data/documents-api.ts` | `POST /documents/:id/snapshots/:snapshotId/restore` | unary | unsafe | |
| `documents.workSource` | `features/documents/data/documents-api.ts` | `POST /documents/:id/work-source` | unary | safe | |
| `documents.workSourcePin` | `features/documents/data/documents-api.ts` | `POST /documents/:id/snapshots/:snapshotId/work-source-pin` | unary | safe | |
| `documents.statuses` | `features/documents/data/documents-api.ts` | `GET /documents/statuses` | unary | safe | |
| `documents.events` | `features/documents/data/documents-api.ts` | `GET /documents/events` | stream | safe | |

### Connections and integrations

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `connections.list` | `features/settings/ui/connections.tsx` | `GET /api/claxedo/integrations` | unary | safe | |
| `connections.connect` | `features/settings/ui/connections.tsx` | `POST /api/claxedo/integrations/:id/connect` | unary | unsafe | Starts an OAuth attempt. |
| `connections.attempt` | `features/settings/ui/connections.tsx` | `GET /api/claxedo/integrations/attempts/:state` | unary | safe | |
| `connections.repositories` | `features/workspaces/ui/dialogs/repository-picker.ts` | `GET /api/claxedo/integrations/connections/:id/repositories` | unary | safe | |
| `connections.disconnect` | `features/settings/ui/connections.tsx` | `DELETE /api/claxedo/integrations/connections/:id` | unary | safe | |

### Provisioning and sandbox

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `sandbox.drivers.list` | `features/settings/ui/sandbox-section.tsx` | `GET /api/workspace/drivers` | unary | safe | |
| `sandbox.drivers.read` | `features/onboarding/sandbox-provider-query.ts` | `GET /api/workspace/drivers` | unary | safe | The onboarding read path for the same route; takes its reader by injection, which is the seam Unit 11 rebinds. |
| `sandbox.drivers.setDefault` | `features/settings/ui/sandbox-section.tsx` | `PUT /api/workspace/drivers/default` | unary | safe | |
| `sandbox.drivers.auth` | `features/onboarding/sandbox-provider-api.ts` | `PUT /api/workspace/drivers/:id/auth` | unary | unsafe | Carries provider credentials; must never be logged. |
| `provisioning.events` | `features/workspaces/ui/dialogs/create-cloud-project.tsx` | `GET /api/claxedo/events` | stream | safe | Filtered view of the same shell stream as `session.events`. |

### Billing

| Operation ID | Owner module | Method + path | Transport | Retry | Notes |
|---|---|---|---|---|---|
| `billing.checkout` | `features/settings/ui/account-section.tsx` | `POST /api/billing/checkout` | unary | unsafe | Returns a redirect target. A duplicate is a duplicate charge attempt. |
| `billing.portal` | `features/settings/ui/account-section.tsx` | `POST /api/billing/portal` | unary | safe | |

## Operations that are not yet platform-neutral

Unit 1 is allowed to conclude that an operation cannot be platform-neutral,
which blocks Unit 9 until it gets a typed broker contract. Two are flagged:

1. **`connections.connect` opens a system browser** and completes through a
   redirect back to the hosted origin. In the desktop composition there is no
   hosted origin to return to; the callback has to arrive through Electron's
   registered scheme and be dispatched to the waiting surface. This shares the
   OAuth callback machinery Unit 6 builds for account sign-in and must reuse it
   rather than adding a second callback path.
2. **`documents.export` currently returns a browser-shaped payload**
   (`Blob` + download). Electron must return a stream handle plus a filename, and
   the renderer must save through a typed operation rather than an anchor click.

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
