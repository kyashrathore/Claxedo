# A workspace on a host, reached over the relay

A workspace is a directory on a **host**: an enrolled machine (the desktop app
or a `claxedo connect` box) or the provisioner's sandbox. The control plane
stores where it runs — a `backing` (`local-worktree` or `cloud-vm`) and a
`placement { host_enrollment_id, directory }` — and nothing about how a
client reaches it. The client answers that itself, at open time, by asking
one question of the placement: **is that host me?** The attached server
declares its own enrollment id in its bootstrap body; `remoteOf` in
`packages/claxedo-app/src/server/wire/placements.ts` compares the
two and marks the placement own (`loopback`) or remote (`relay`). The wire is never stored and never
sent.

This document follows one user from publishing a machine to attaching to a
running session on it from another device, naming the owner of each step.
Three surfaces read the same code: the signed-out desktop (everything is
loopback), the signed desktop (loopback to its own machine, relay to every
other host), and the web client (relay to every host, because a browser is
no machine). Every claim is read from the code named beside it; where the
code still carries something this document does not describe, the section
says so.

## A. The host: one identity, one beat

**A.1 Desktop, enable remote access** — the preload bridge
(`packages/claxedo-desktop/src/preload/index.ts`) exposes the connector's own
zero-argument IPC `claxedo.hostConnector.start`
(`packages/claxedo-desktop/src/main/host-connector/ipc.ts`). No app surface
invokes it: Settings → Machines
(`packages/claxedo-app/src/settings/view/machines.tsx`) renders "Enable remote
access" disabled. The IPC calls
`start()` on the supervisor `setupHostConnectorChild`
(`child-supervisor.ts`, built by `setupElectronHostConnector` in
`electron-child.ts`). `launch` loads the machine identity from the
`safeStorage`-encrypted identity file (`identity-store.ts`), spawns the
connector child (`packages/claxedo-desktop/src/host-connector-child/entry.ts`),
reads the daemon's `GET /api/claxedo/host-serving` for `sessionAuthority`
(`src/main/index.ts`; an unreachable daemon leaves it undeclared rather than
guessed), and sends the child one `bootstrap` message with the control-plane
URL, the identity, the stored display name and the shared workspace list.

The child answers the bootstrap as soon as it holds an identity, then
enrolls: `enroll` runs `host.enrollmentNonce` and `host.enrollCurrentMachine`
as `account-operation` messages that Electron main performs with the account
credential (`child-protocol.ts` names the two; `RENDERER_WITHHELD_OPERATIONS`
in `src/main/account/account-ipc.ts` refuses them to the renderer). Every
`start()` enrolls again, and the enroll route overwrites `display_name`,
which is why the owner's rename is stored on the machine too
(`machineNameFile` in `electron-child.ts`). With the `enrollment_id` the
child builds `createHostConnector({ mode: "machine", transport:
createMachineSignedTransport(...) })`
(`packages/claxedo-host-connector/src/connector.ts`, `machine-transport.ts`).
From here the desktop is indistinguishable from a `claxedo connect` host:
`start()` acquires a serving generation, then every beat is a machine-signed
`POST /api/claxedo/host/enrollments/heartbeat` carrying `generation`, the
`acks`, the daemon's `sessionAuthority`, the sealing public key and the
provider-config revision it holds (`runBeat` in `connector.ts`). No account
credential is on the beat path; the account is spent on the two enrollment
calls and never again.

**A.2 What a beat answers, and what the connector does with it** — the
control plane's `machineHeartbeat`
(`packages/claxedo-server/src/routes/hosted/host-enrollment.ts`) runs the
machine path in order: client-address budget, `verifyMachineRequest` over the
exact body text, per-enrollment budget, schema, then
`authority.heartbeatHostEnrollmentByMachine` (D1
`authority/adapters/d1/host-access-authority.ts`, SQLite
`claxedo-server-core/.../sqlite/workspace-authority.ts`). The authority
renews the lease, records the acks and stores `session_authority` through
the one narrowing `hostSessionAuthority()`
(`claxedo-server-core/src/platform/auth/authority.ts`): the latest beat
assigns it, and a host that stops declaring is undeclared again. The answer
carries the assignment descriptions with revisions, the scope, the endpoints
(`relay { url, jwks_url }`, `authority { session_authority_url }`),
`serving_generation`, and ONE `hostTunnel` credential whose claim is exactly
the workspaces both assigned and acked at their current revision, restating
`enrollmentId` and `relayUrl`. `reconcile` in `connector.ts` applies it in
the control plane's own order — scope, endpoints, provider config (strictly
newer revisions only), assignments — and then `onServing` hands the
credential on.

**A.3 Serving: the daemon owns the tunnel** — the child posts a `serving`
message; main pushes it verbatim to the daemon's `PUT /api/claxedo/host-serving`
(`host-connector/serving-push.ts` → `HostServingRoutes` in
`packages/claxedo-local-server/src/workspace/host-serving-routes.ts`). That
route validates the ack's own shape (`HostServingCredential`: `hostId`,
`enrollmentId`, `relayUrl`, `hostTunnelToken`, `tokenExpiresAt`, `jti`,
`workspaceIds`), installs the two addresses a relayed caller is admitted by
(`setLocalHostEndpoints` in `deployments/local/host-session-authority.ts`),
and calls `setHostServing` (`packages/claxedo-host-serving/src/serving.ts`)
with `HostServingComposition { localBaseUrl, sessionAuthority:
embeddedWorkspaceRuntimeSessionAuthority }`. `setHostServing` opens one relay
connection per workspace (`startWorkspaceRelayHostTunnel`; the relay refuses
a multi-workspace connect), reconciles only the difference on each renewal,
and arms a lapse timer on `tokenExpiresAt`: serving is a lease, and a
machine whose beats stop is stopped by `stopHostServing` rather than left
claiming `serving: true`. `hostServingSurface` (`surface.ts`) decides where
each relayed path lands — the daemon's own `/api/claxedo`, `/api/cp`,
`/api/control`, `/api/workspace`, `/api/auth`, `/api/runtime-authority`
families are denied outright; the root compat routes (`/provider/auth`,
`/config`, `/project`, `/auth/:provider`, the OAuth steps) are re-scoped to
the tunnel's own workspace; everything else reaches the embedded runtime at
`/workspaces/:id/*`. `hostServingEnrollmentId()` reads the enrollment off
the live serving arrangement and is what the daemon declares to its own
clients (B.1); it goes away with every way serving ends.

**A.4 Publishing one workspace** — the app has no caller that publishes a
workspace. The owner's declaration is `POST /api/workspace/:id/host-assignment`
(`packages/claxedo-server/src/routes/hosted/workspace.ts`, and the self-hosted
node's `packages/claxedo-server/src/workspace/routes/index.ts`), which Electron
main sends as the account operation `workspace.assignHost`
(`packages/account-contract/src/hosted-operations.ts`).
On the desktop the port is `claxedo.hostConnector.share`, which carries a
workspace id and a label and nothing that names a machine; the supervisor's
`shareWorkspace` describes the workspace (`describeWorkspace`: directory,
repository, branch), runs the account operation `workspace.assignHost` with
THIS machine's host id (the owner's declaration, an upsert on the workspace
id), then sends `share-workspace` to the child, which acks the description
that comes back at its revision on a forced beat. Routing at the control
plane requires all three: owner-assigned, machine-acked at the current
revision, live lease. Shares are remembered in
`host-connector-shared-workspaces.json` so a restart re-establishes them.

**A.5 The account is a verdict, not a heartbeat** — `remoteAccessFollow`
(`host-connector/account-follow.ts`): signed → lost is `suspend`
(`suspendForAuthLapse` kills the child and pushes `{ tunnel: null }` so the
daemon closes its tunnels at once); lost → signed is `resume` (one restart,
consumed before the attempt); a transient outage is `hold`, and the
connector keeps beating, because its own beat already tells a refused
credential (stops) from an unreachable control plane (carries on:
`transientHeartbeatFailure` in `connector.ts`). The user's pause and a revoke
clear the suspension so a later sign-in cannot undo a decision.

**A.6 `claxedo connect`** — a connect box redeems an invitation through
`packages/claxedo-host-connector/src/bootstrap.ts` and runs `createHostConnector`
in machine mode. Its `roots` and `resolvePath` refuse assignments outside the
served roots before acknowledgment. Heartbeats and enrollment reach the hosted
Cloudflare authority through the machine transport.

**A.7 The tunnel replays onto loopback** — both tunnel owners
(`host-serving/src/serving.ts`, `claxedo-server/src/host-tunnel.ts`)
replay a relayed request as a fetch to the machine's own listener with
`loopbackReplayHeaders`
(`claxedo-server-core/src/platform/http/peer-address.ts`): the remote
browser's `Origin` and `Host` never reach the daemon's loopback gate. What
separates the replayed request from the machine's own user is decided at
ingress (F.2), never by its address.

## B. The client sees the machine and its workspace

**B.1 Boot and declaration** — the app learns which machine it is attached to
from one read, `GET /api/claxedo/bootstrap`, made before any stream opens.
`App` (`packages/claxedo-app/src/app.tsx`) mounts `AuthProvider` with the
build's account binding (`#account-binding`, chosen in
`packages/claxedo-app/vite.account-binding.ts`:
`packages/claxedo-app/src/auth/better-auth-binding.ts` for the browser,
`packages/claxedo-app/src/auth/electron-binding.ts` for the desktop), and
`SignedServer` builds one `ServerScope` per principal. `serverAccess` picks
what the attached server sees: no credential when signed out; no credential plus the account's `run`
on a signed desktop, whose binding reaches the control plane as a `port` over
Electron main, so the daemon never receives a user bearer; a bearer in a
signed browser.

`createServer` (`packages/claxedo-app/src/server/server.ts`) then runs
`createStartup`:
1. `workspaces.load()` (`createWorkspaces` in
   `packages/claxedo-app/src/server/workspaces.ts`) reads the bootstrap, and
   `bootstrapCatalog` (`packages/claxedo-app/src/server/wire/placements.ts`)
   decodes it into a `BootstrapDeclaration` — `hostAggregate`
   (`events.hostAggregate`), `issuesSessions` (`deployment.issuesSessions`),
   `documents`, and `enrollmentId` (`host.enrollment`) — plus the placements
   (B.2).
2. The event streams open with that declaration (F.1).
3. `capabilities.load()` derives `Capabilities` from the declaration alone
   (`packages/claxedo-app/src/server/capabilities.ts`). `thisMachine`
   (`packages/claxedo-app/src/server/machines.ts`) names the machine: on a
   loopback server its id is the enrollment id, or `UNENROLLED_MACHINE`
   (`"this-machine"`) before enrollment; off loopback there is none.

A bootstrap that fails before any stream opens leaves `server.connection`
offline with its reason, and `retryConnection` reads it again.

Two servers answer the route, and they declare different facts:
- The daemon's `BootstrapRoutes`
  (`packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts`,
  mounted in `packages/claxedo-local-server/src/app/local-app.ts` with
  `hostEnrollmentId: hostServingEnrollmentId`; the self-hosted node mounts the
  same routes with its own auth config). The desktop daemon's auth config is
  local-only (`packages/claxedo-local-server/src/app/local-services.ts`), so
  it declares `deployment.issuesSessions: false`. Its body carries
  `host.enrollment` (this machine's enrollment id while it serves, A.3, else
  `null`), `events.hostAggregate` (whether it mounts the host aggregate
  `wr/events`), and `project`: its own workspace store's projects, each
  workspace row carrying `reachable` and, for a workspace this process
  serves, `session_authority`.
- The hosted control plane (`packages/claxedo-server/src/routes/hosted/shell.ts`)
  declares `events.hostAggregate: false`, its own `issuesSessions` and no
  `host`, and adds `project` only for a caller holding a credential:
  `signedShellProjects` groups the authority's rows by project, addresses
  each workspace as `workspace:<id>`, and sets `reachable` through
  `authorityRowReachable`
  (`packages/claxedo-server-core/src/workspace/placement-reachability.ts`: a
  cloud workspace whose sandbox lease is ready, or a machine row whose
  `host_online` is true). A browser therefore holds no enrollment id, which is
  correct: no machine is behind it.

**B.2 Catalog** — `createWorkspaces`
(`packages/claxedo-app/src/server/workspaces.ts`) is the one owner of
placements; routing, the rail and every session read look placements up in
it synchronously. It keeps the bootstrap catalog in the query cache under
`queryKeys.bootstrap` and observes it for its whole life, so the cache never
collects it. `placementsFromProjects`
(`packages/claxedo-app/src/server/wire/placements.ts`) turns each workspace
row into a `PlacementRecord`: a `Placement` (`id` is the workspace id; `kind`
is `folder`, `worktree` or `cloud`; `path` is the host's `remote_directory`
when the row has one; `reachable`; `machineId`; `gitRemote`) and a
`RuntimeRoute { directory, workspaceId, remote }`.

On a signed desktop the catalog has a second source, the account's:
1. `createAccountPlacements`
   (`packages/claxedo-app/src/server/account-placements.ts`) runs the account
   operations `workspace.list.provisioner` and `workspace.list.machine`
   through `HostedAccount` (`packages/claxedo-app/src/server/account.ts`).
2. Electron main sends them as `GET /api/workspace?host=provisioner` and
   `?host=machine` (`packages/account-contract/src/hosted-operations.ts`).
   The control plane answers from `authority.listWorkspaces` and filters
   `host=machine` to `backing === "local-worktree"` rows
   (`packages/claxedo-server/src/routes/hosted/workspace.ts`; the self-hosted
   node's `packages/claxedo-server/src/workspace/routes/index.ts` answers the
   same query).
3. `accountCatalogFromWire`
   (`packages/claxedo-app/src/server/wire/account-catalog.ts`) groups the rows
   into projects by `project_id` and makes every row a remote
   `workspace:<id>` placement whose `machineId` is the row's
   `placement.host_enrollment_id`.
4. `linkAccountCatalog` (`packages/claxedo-app/src/server/account-link.ts`)
   drops an account row whose workspace id the daemon already places, so the
   daemon's copy wins, and moves a paired project's other placements under the
   local project. `accountProjectIds` names the control-plane projects whose
   sessions belong to a project (D).

If the account catalog cannot be read, the failure is logged and the desktop
lists its own placements. `workspaces.refresh` re-reads both sources.

`accountCatalogFromWire` reads each row's `reachable`. Both `/api/workspace`
list routes set it through `withAuthorityRowReachability`
(`packages/claxedo-server-core/src/workspace/placement-reachability.ts`): a
machine row is reachable when its enrollment serves it (`host_online`), a
cloud row when its sandbox lease is ready.

**B.3 Address** — a workspace is addressed by its id everywhere in the app.
The placement id is the workspace id, and the shell's routes name it
(`packages/claxedo-app/src/shell/routes.ts`): `/w/<placementId>/session/<sessionId>`,
`/w/<placementId>/terminal/<terminalId>`, and `/s/<sessionId>` for a session
in this machine's own folders and worktrees (`sessionLinkPath`). A remote
placement's `RuntimeRoute.directory` is `workspace:<id>`; the host's own path
is display data in `Placement.path`.

`address.placementFor(directory, workspaceId?)` (`packages/claxedo-app/src/server/workspaces.ts`) is
how anything the server names — a session-list row, an event frame — finds
its placement. It matches by workspace id when one is given. Otherwise it
matches a placement whose route directory or `path` equals the directory, or
whose id a `workspace:<id>` ref names. For a directory it cannot place,
`workspaces.learn` re-reads the bootstrap once per directory until the next
refresh.

**B.4 Wire** — `createTransport`
(`packages/claxedo-app/src/server/transport.ts`) decides per request whether a
runtime call stays on the attached server, goes through the daemon's
workspace proxy, or goes through the relay. It uses two facts: the route's
`remote` and whether the server URL is loopback (`isLoopbackUrl` in
`packages/claxedo-app/src/server/config.ts`).

`remote` comes from `remoteOf` (`packages/claxedo-app/src/server/wire/placements.ts`):
- a `cloud` or `cloud-vm` row is remote;
- a `local-worktree` row is remote unless its `placement.host_enrollment_id`
  equals the declared enrollment id;
- any other row is this machine's.

`transport.runtime(route, path)` then branches:
- If the route is not remote, the request goes to the attached server with
  `?directory=<route.directory>`.
- If it is remote and the server is loopback, the request goes to the
  daemon's `/workspaces/<id>` surface, `createLocalWorkspaceRelayProxy`
  (`packages/claxedo-local-server/src/workspace/runtime-dispatch/shared-workspace-endpoint.ts`,
  mounted ahead of the runtime proxy in `packages/claxedo-local-server/src/app/local-app.ts`). That handler refuses
  a caller that is not loopback (401 `workspace_relay_local_loopback_required`)
  and resolves the id in the daemon's own workspace store (404
  `workspace_relay_workspace_not_found` when it holds none). It serves a
  non-cloud workspace from its embedded runtime, and a cloud one by ensuring
  the sandbox (`ensureCloudRuntime`) and proxying to it.
- Otherwise the request goes through the relay (`createRelay` in
  `packages/claxedo-app/src/server/relay.ts`, C).

`transport.runtimeSocket` makes the same choice for WebSockets.

The catalog also stops requests before they leave. `workspaces.route`
refuses a stopped cloud placement (`isStoppedCloud` in
`packages/claxedo-app/src/server/placement-runtime.ts`) with
`workspace_stopped`. `workspaces.home` marks a remote non-cloud placement that
is not `reachable` as not live, so its session reads come from the control
plane's inventory (E.1). `isOfflineMachine` tells the screen that the
placement's machine is offline.

Observed limit: on a signed desktop, another machine's workspace comes only
from the account catalog, and the daemon's `/workspaces/<id>` surface serves
only ids in its own store. The desktop therefore has no path to that
machine's runtime.

## C. Connecting: the mint

A client dials the relay only when it is attached to a server that is not
loopback, and it does so under a Runtime Access Token that the control plane
mints at `/api/workspace/:id/connection`. On a loopback server the app never
mints: the daemon's proxy reaches the runtime itself (B.4).

**C.1 Client** — `createRelay` (`packages/claxedo-app/src/server/relay.ts`)
holds one connection promise per workspace:
1. The first request reads `GET /api/workspace/:id/connection`.
   `connectionAnswerFromWire`
   (`packages/claxedo-app/src/server/wire/connection.ts`) reads `status`,
   where `provisioning` and `stopped` fail the read as `workspace_stopped`, or
   else the link `{ relayUrl, runtimeAccessToken, tokenExpiresAt }`. It reads
   nothing else of the body.
2. A link within 60 s of expiry is read again.
3. A request goes to `<relayUrl>/workspaces/<id><path>` with
   `Authorization: Bearer <runtimeAccessToken>` and `credentials: "omit"`; a
   WebSocket carries the token as the `claxedo-rat.<token>` subprotocol.
4. If the relay answers 401, `startWorkspace`
   (`packages/claxedo-app/src/server/workspace-start.ts`) posts
   `POST /api/workspace/:id/connection` until the server answers ready. It
   waits the server's `retryAfterMs` (clamped to 0.5–30 s) on a
   `provisioning` answer or a 409 `cloud_runtime_unavailable` that carries
   one, for at most 30 attempts. The request is then sent once more on the
   new link.

`transport.startRuntime` is the same start for an explicit wake; off loopback
the relay adopts the link it returns.

**C.2 Server** — `POST /api/workspace/:id/connection` and
`/connection/refresh` go to `hostedConnectionInfo`
(`packages/claxedo-server/src/connections/hosted-connection-info.ts`), and
`GET` goes to `hostedConnectionStatus`. Both open the workspace through the
authority and branch on `backing`:
- `local-worktree` goes to `hostTunnelConnectionInfo`
  (`packages/claxedo-server/src/connections/host-tunnel-connection.ts`) on
  `GET` as on `POST`. The host must be live (`activeWorkspaceHost`, else 409
  `workspace_host_offline`). The relay URL comes from the workspace's home
  region. A Runtime Access Token is minted for the verified actor, the org,
  the workspace and the host id, and only for the workspace's owner; it is
  recorded and audited, and a previous token the caller names is revoked.
  `GET ...?sessionId=` is the share holder's path instead
  (`hostedSessionConnection` in
  `packages/claxedo-server/src/connections/hosted-connection-info.ts`): it
  mints a `viewer` token scoped to that one session for anyone who may read
  it. The answer
  carries `backing`, `relayUrl`, `runtimeAccessToken`, `tokenExpiresAt`,
  `role`, and `sessionAuthority` exactly as the host declared it on its beat
  (none when the host declared none).
- `cloud-vm`: `GET` reads the lease through `sandboxManager.target` and never
  starts a sandbox; `POST` ensures the sandbox. The answer's
  `sessionAuthority` is the fixed `"managed-private"`.

The app reads neither `sessionAuthority` nor `role` from this answer; whether
to reserve comes from the attached server's declaration (E.2).

Relay-side, `packages/workspace-relay/src/cors-origins.ts` compiles one
origin matcher (`createOriginMatcher`, `DEFAULT_RELAY_APP_ORIGINS`) that both
`packages/workspace-relay/src/cloudflare.ts` and
`packages/workspace-relay/src/cloudflare.ts` stamp on browser-facing responses.

## D. Listing sessions: the attached server's list, plus the account's

A project's sessions are one keyset page merged from the attached server's
list and, on a signed desktop, the account's list. The app reads no session
list from a runtime. A machine's sessions reach the control plane's list
because the machine publishes them.

**D.1 The page** — the session list's reads
(`packages/claxedo-app/src/session/list/reads.ts`) call
`server.sessions.list`, which is `listSessions`
(`packages/claxedo-app/src/server/session-list.ts`), and `sourcesOf` builds
the sources:
- `serverSource` reads the attached server's list: `GET
  /api/claxedo/session-list` on a loopback server (the daemon's
  `packages/claxedo-local-server/src/session/routes/meta-routes.ts`), and
  `GET /api/control/session-list` otherwise (`signedSessionList` in
  `packages/claxedo-server/src/session/list.ts`, served by
  `packages/claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts`
  and `packages/claxedo-server/src/session/routes/control-plane-session.ts`).
  It always asks `scope=project` with the project id, `sort=human_turn_desc`,
  `limit` and `after`. This source is required.
- On a signed desktop, `accountSource` reads each control-plane project that
  `accountProjectIds` pairs with the project, through the account operation
  `session.page` (`GET /api/control/session-list?scope=project`). It is
  optional, except for a project that exists only in the account catalog,
  where it is the only source and required.

`readSessionSources` (`packages/claxedo-app/src/server/session-sources.ts`)
reads every source after the same order key and takes the first `limit` rows
of their union in list order. A session that two sources answer keeps the
first source's copy, which is the daemon's. `nextAfter` is the last row
shown, and a failed optional source marks the page `degraded`. `listedOf`
then maps each row to its placement through `address.placementFor` (B.3),
re-reading the catalog once for a directory it cannot place and dropping a
row that stays unplaced.

**D.2 Where a machine's rows come from** — the daemon's
`startSessionRowsPublisher`
(`packages/claxedo-local-server/src/session/publish/start-session-rows-publisher.ts`,
started by `packages/claxedo-local-server/src/app/start-local-server.ts`)
publishes this machine's session rows, built from its session projection and
its embedded runtimes' status. It posts them to the session-rows URL its
heartbeat delivers, `POST /api/claxedo/host/session-rows`
(`HostSessionRowsRoutes` in
`packages/claxedo-server/src/routes/hosted/host-session-rows.ts`), with the
serving credential. The route admits each row against what that enrollment
serves at that moment. These rows are what `/api/control/session-list` lists
for a machine-placed workspace.

## E. Opening a session and creating one

**E.1 Open** — a rail row opens `sessionLinkPath` (B.3). The transcript store
(`packages/claxedo-app/src/session/transcript/store.ts`) holds
`server.attachPlacement(placementId)` for as long as the session is open, so a
remote placement's runtime stream is open (F.1). `workspaces.home`
(`packages/claxedo-app/src/server/workspaces.ts`) and `onRuntime`
(`packages/claxedo-app/src/server/session-context.ts`) decide where the reads
go:
- A cloud placement's history comes from the control plane
  (`packages/claxedo-app/src/server/central-session.ts`:
  `/api/control/sessions/:id/outline`, `/page` and `/part`, through
  `HostedAccount` on a signed desktop). Its live facts come from its runtime
  while the sandbox runs.
- Any other live placement's first read is the runtime's
  `GET /session/:id/outline` over the wire B.4 chose
  (`packages/claxedo-app/src/server/session-reads.ts`).
- A remote machine placement that is not `reachable` is not read: its row
  comes from the control plane's inventory, its transcript is empty until the
  machine is back, and an older-page or part read is refused as a network
  error.

A runtime read that answers `workspace_stopped` re-reads the catalog once and
answers the stopped facts.

**E.2 Create** — `createSession`
(`packages/claxedo-app/src/server/sessions.ts`) runs in this order:
1. It wakes a stopped cloud workspace first (`wakeIfStopped` in
   `packages/claxedo-app/src/server/workspace-wakes.ts`).
2. It reserves only when the attached server declared
   `deployment.issuesSessions` (B.1). `reserveSession`
   (`packages/claxedo-app/src/server/session-reservation.ts`) posts
   `/api/control/session-registrations/reserve` with a client-minted session
   id and operation id (`PrivateSessionRegistrationRoutes` in
   `packages/claxedo-server/src/routes/private-session-registration.ts`,
   mounted by the hosted core and the self-hosted node).
3. It creates the session on the runtime over the placement's wire, under the
   reserved id and with the `x-claxedo-session-registration-operation`
   header when it reserved.

The desktop daemon declares `issuesSessions: false`, so its own window never reserves,
signed in or out. On a server that issues sessions, `createSessionProjection`
(`packages/claxedo-app/src/server/session-projection.ts`) also registers a
created cloud session (`POST /api/control/workspaces/:id/sessions/:sid/register`)
and asks for a checkpoint at every turn end.

On the runtime, `managedSessionLifecycle` in
`packages/workspace-runtime/src/routes/session-route-options.ts` decides per
request. The private lifecycle (a reservation before the create, a registered
creator, a durable turn lease through `acquireManagedPromptLease`) applies when
the policy is `managed-private` AND `sessionRequestProvenance(c)` is
`relay-replayed`; a loopback-direct request creates with no reservation and
no round trip. A relayed root create with no operation id is refused 400
`session_reservation_required`. The daemon composes its runtimes with
`localHostSessionAccessPolicy` and `loopbackSessionAuthority: "local"`
(`packages/claxedo-local-server/src/app/start-local-server.ts`), so it
declares `managed-private` to the control plane while this machine's own
window keeps the local lifecycle.

## F. Live streams: the server's streams and one stream per open remote placement

The workspace runtime serves one stream, `GET /api/wr/events`
(`packages/workspace-runtime/src/routes/events.ts`). Every data frame is
`{ directory, payload }`: the projected client-presentation events, the
`subagent.updated` and `goal.*` runtime-channel events, and the workspace's
control frames from `workspaceRuntimeBus` (`pty.*`, `process.*`,
`agent.lifecycle`, `session.lifecycle`).

**F.1 What the client opens** — two owners open streams, and every stream is
`openStream` (`packages/claxedo-app/src/server/stream.ts`):
- `createEventStreams` (`packages/claxedo-app/src/server/streams.ts`) opens,
  at boot, `GET /api/cp/events` on the attached server and, only when the
  declaration says `hostAggregate`, the host aggregate `GET /api/wr/events`
  naming no workspace. On the daemon the aggregate carries every embedded
  runtime's frames on one connection (`createHostAggregateEventsHandler` in
  `packages/claxedo-local-server/src/shell/host-events.ts`), and it is refused
  to any reader that is not loopback-direct.
- `createPlacementStreams`
  (`packages/claxedo-app/src/server/placement-streams.ts`) opens a remote
  placement's own `GET /api/wr/events` through `transport.runtime` (the
  daemon's proxy on loopback, the relay otherwise). It opens the stream while
  at least one of the placement's sessions is attached (E.1) and the catalog
  says the placement is `reachable`, closes it when either stops, and
  reconciles on every update of the bootstrap catalog. Refused with 403
  `workspace_event_stream_denied` (F.2), the placement reads one
  `?sessionID=` stream per attached session instead. A placement that is not
  remote gets no stream of its own; on the daemon the aggregate carries it.

`openStream` reads SSE and resumes by `Last-Event-ID`. It reconnects with a
backoff that doubles from 250 ms to 15 s and never gives up, and it drops and
reopens a stream that sends no frame for 40 s. A 403 is the answer, not a
failure: the stream goes offline, reports the refusal and never reopens. A `stream.replay-gap` frame
becomes `streamGap`, on which every store re-reads.

**F.2 The runtime decides the arm** — the runtime decides from the REQUEST,
not from the composition. `authorizeSessionEventScope`
(`packages/workspace-runtime/src/routes/session-event-privacy.ts`):
- a policy that is not `managed-private` reads the whole stream;
- a request whose provenance is `loopback-direct` reads the whole stream too,
  because that is the machine's own user;
- a `relay-replayed` request with no `sessionID` asks `policy.authorizeHost`
  (the control plane's `host_read`). Admitted, it reads unscoped under a
  workspace lease, seeing the session-less frames and, session by session,
  only what the session authority grants. Refused, it is answered 403
  `workspace_event_stream_denied`, the cue to reopen `?sessionID=` for one
  session under a lease (`authorizeStream`; 403 there is
  `session_event_stream_denied`).

A subagent child's frames are scoped as its parent's.

Provenance is stamped once at the daemon's ingress,
`resolveIngressProvenance`
(`packages/claxedo-local-server/src/workspace/runtime-dispatch/ingress-provenance.ts`),
which the desktop daemon mounts with `verifyRelayIngress: true`
(`packages/claxedo-local-server/src/app/start-local-server.ts`):
- a bearer that verifies as a Relay Host Token against the relay's key set
  (`localHostRelayActor` in
  `packages/claxedo-local-server/src/deployments/local/host-session-authority.ts`)
  stamps `relay-replayed` with the actor, org, role and session scope;
- a request that says it came through the relay
  (`x-forwarded-by: workspace-relay`) but does not verify is refused 403
  `relay_actor_unverified`, never treated as local;
- a request that is neither verified nor loopback is refused 403
  `workspace_request_not_loopback`;
- only an unmarked loopback request is `loopback-direct`.

The daemon's policy is `localHostSessionAccessPolicy` —
`remoteWorkspaceSessionAccessPolicy` with `requireActor: false` and the
control plane's authority URL read per call from the heartbeat ack — so it
declares `managed-private` while its own user keeps the local lifecycle. Its
`adoptRefusedSession` claims a session the control plane has no row for, on
the owner's own first relayed read of one the embedded runtime actually
holds. Sessions created before remote access was turned on therefore become
reachable without registering anything the owner never opened remotely.

Per session, D1 asks `may` on the session
(`packages/claxedo-server/src/authority/adapters/d1/authorization.ts`).
Standing in the session's organization is necessary and never sufficient;
then the workspace's owner or a share grant admits: `follow` reads and
streams, `send` also drives the agent's turn, and a `session_control` write
drops the share branch. No rank on the organization or the project admits
anyone, and a share reaches its session only while the owner still stands.
**F.3 Frame address** — every frame a runtime publishes names its own
filesystem directory: this machine's path, another machine's path, or the
sandbox's. `createEventIntake`
(`packages/claxedo-app/src/server/event-intake.ts`) maps each frame to a
placement with `address.placementFor(directory, workspaceId)` (B.3), so a
remote placement's frames match through the frame's workspace id or the
placement's `path`. If a frame names a directory the catalog does not place,
the intake holds that frame and every later one behind a catalog re-read
(`workspaces.learn`), once per directory; a failed re-read becomes
`streamGap`. Frames are published in arrival order.

**F.4 Projection** — the host projects a turn's raw harness frames through
`createClientPresentationProjection`
(`packages/workspace-runtime/src/projection/client-presentation`) before
they reach the wire; the client projects nothing. The reply id is minted
from the prompt by `assistantMessageIdForTurn`
(`packages/agent-runtime-contract/src/turn-message-ids.ts`,
`${userMessageId}_r`), and `packages/workspace-runtime/src/session/service.ts`
announces the assistant row under it for a turn nobody on the client
started.

The result: for a reader the workspace authority admits, a turn started on
the machine streams into a session open on another device through that
placement's stream, delta by delta. A share grantee without workspace access
is refused the unscoped arm, and the app opens no session-scoped stream for
them.

## G. Terminals and configuration

**G.1 Terminals** — a terminal is a runtime PTY reached over the placement's
wire (B.4). `createTerminalsApi`
(`packages/claxedo-app/src/server/terminals.ts`) lists and creates with
`GET`/`POST /api/wr/pty` through `transport.runtimeJson`, and attaches with
`transport.runtimeSocket` to `/api/wr/pty/:id/connect`. On loopback the
daemon's `mountWorkspaceRuntimePtyWebSocketProxy`
(`packages/claxedo-local-server/src/deployments/local/server-workspace-pty-proxy.ts`)
carries that socket for a `/workspaces/<id>` route. The terminal store
(`packages/claxedo-app/src/terminal/store.ts`) creates a terminal with the
session the route has open on that placement. `createPty`
(`packages/claxedo-app/src/server/terminals.ts`) sends it only for a
placement reached over the relay, and refuses such a placement with no open
session before any request (`terminal_session_required`); the terminal
creator shows "Open a session on this machine to start a terminal". A
placement this machine serves creates terminals without a session, and
`recoverTerminal` passes the session id the lost terminal carried.

On the runtime, `PtyRoutes` (`packages/workspace-runtime/src/routes/pty.ts`)
requires a relayed create on a managed runtime to name the session it
belongs to (400 `pty_session_id_required`) and authorizes `pty_write` on that
session. A token scoped to one session never reaches `/api/wr/pty`, process
or Git routes: the relay refuses them (403 `relay_scope_denied`), and so do
the runtime's relay-host middleware and its embedded exposure, with the same
`sessionScopeReaches` rule. A terminal's `pty.*` frames ride the workspace bus.
That is why the app never asks such a runtime for a terminal without a
session; flow 24 proves both arms on a live sandbox.

**G.2 Configuration** — provider configuration the owner pushed to a machine
reaches the daemon over `PUT /api/claxedo/host-provider-config`
(`packages/claxedo-local-server/src/workspace/host-provider-config-routes.ts`,
mounted in `packages/claxedo-local-server/src/app/local-app.ts`), a loopback-only surface the relay's
`hostServingSurface` denies. The app reads a placement's harness options
from the attached server, not the runtime: `readHarnessOptions`
(`packages/claxedo-app/src/server/harness-options.ts`) asks
`GET /api/claxedo/agent-config/harness/options` with the placement's
workspace id, and the answer's `resolvedModel` is the model the harness
resolved. The daemon serves that route
(`packages/claxedo-local-server/src/agent-config/routes/harness-routes.ts`);
the hosted control plane serves it too, reading the workspace runtime's
`/api/wr/harness-config-options` (or the session's `config-options`) over the
relay beside its harness health route
(`packages/claxedo-server/src/routes/hosted/shell.ts`).

## H. Authority on the runtime side

`managedWorkspaceSessionAccessPolicy`
(`packages/workspace-runtime/src/session-access-policy.ts`) is built from one
all-or-nothing `ManagedSessionAuthority` bundle — read, write, stream,
register, and the three turn-lease members — and `sessionAuthority` is
`managed-private` exactly when the bundle exists. That marker is a
DECLARATION: the control plane records it and the client reads it to know
whether to reserve. The decider of registration, turn admission and event
privacy is the request's provenance, `sessionRequestProvenance`, read at the
three sites named in E.2 and F.2. The token's scope, not a role, answers
what it reaches (`authorizeManaged`): a token with no session is the
workspace owner's and reaches the workspace; a token scoped to one session is
refused on any other (403 `session_scope_denied`). A session-scoped write is
the session authority's question, carried with its class
(`sessionAccessWriteClass`: `agent_turn` for prompt, permission and question
responses, and abort; `session_control` for everything else). Stream authorization
and lease minting have one owner, `authorizeRuntimeSessionStream` in
`packages/claxedo-server/src/routes/runtime-session-authority.ts`.

A workspace is its owner's alone. Every D1 access question goes through
`may` (`claxedo-server/.../d1/authorization.ts`), and on a workspace it
answers the owner (`workspaces.owner_user_id`, with an active membership of
the workspace's org) and nobody else: seeing the placement, the
workspace-scoped surfaces (files, terminals, processes, git), creating or
forking a session, and a workspace-wide runtime token. The SQLite store's
`workspaceRoleForUser`
(`claxedo-server-core/.../sqlite/workspace-authority-store.ts`) answers the
same. An organization, its teams and a project's grants group people and
govern the project; they grant nothing on a machine, a runtime or a folder.

The only grant one person makes to another is a session share
(`POST /api/control/sessions/:id/shares`, level `follow` or `send`), and it
is the whole admission to that one session (F.2). Only the workspace's owner
may grant or revoke its shares, and only to a member of the session's
organization.

## I. How it is proven

Nothing in this list was run while this document was written; each entry
names the file and what it claims to cover.

- **Daemon probe** (`packages/claxedo-local-server/src/app/desktop-session-authority.test.ts`)
  runs the same request twice against a real `startLocalServer`, once with the
  relay's marks and once without, with the session authority and the relay
  bearer verification faked, and asserts which of them the daemon consults.
- **App e2e** (`packages/claxedo-app/e2e/`): no flow drives a machine-placed
  workspace. Its relay harness (`packages/claxedo-app/e2e/harness/relay.ts`)
  backs the signed stack (`packages/claxedo-app/e2e/harness/signed-stack.ts`).
