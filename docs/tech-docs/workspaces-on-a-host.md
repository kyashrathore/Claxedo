# A workspace on a host, reached over the relay

A workspace is a directory on a **host**: an enrolled machine (the desktop app
or a `claxedo connect` box) or the provisioner's sandbox. The control plane
stores where it runs — a `backing` (`local-worktree` or `cloud-vm`) and a
`placement { host_enrollment_id, directory }` — and nothing about how a
client reaches it. The client answers that itself, at open time, by asking
one question of the placement: **is that host me?** The attached server
declares its own enrollment id in its bootstrap body; `placementWire` in
`packages/claxedo-app/src/platform/runtime/placement-wire.ts` compares the
two and answers `loopback` or `relay`. The wire is never stored and never
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

**A.1 Desktop, enable remote access** — the panel invokes the connector's own
zero-argument IPC `claxedo.hostConnector.start`
(`packages/claxedo-desktop/src/main/host-connector/ipc.ts`), which calls
`start()` on the supervisor `setupHostConnectorChild`
(`child-supervisor.ts`, built by `setupElectronHostConnector` in
`electron-child.ts`). `launch` loads the machine identity from the
`safeStorage`-encrypted identity file (`identity-store.ts`), spawns the
connector child (`packages/claxedo-desktop/scripts/host-connector-entry.ts`),
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

**A.4 Publishing one workspace** — `publishWorkspacePlacement`
(`packages/claxedo-app/src/features/workspaces/data/share-workspace.ts`) goes
through the machine remote-access port when one is bound (the desktop) and
otherwise posts the self-hosted server's own `POST /api/workspace/:id/host-assignment`.
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

**A.6 `claxedo connect` and the self-hosted node** — a connect box is
enrolled by redeeming an invitation
(`packages/claxedo-host-connector/src/bootstrap.ts`) and then runs the same
`createHostConnector` in machine mode, supplying `roots`/`resolvePath` so an
assignment outside its roots is refused at `ack`. The self-hosted node
(`packages/claxedo-server/src/deployments/self-hosted-node/remote-access-service.ts`)
holds the authority in-process, so its beat calls
`heartbeatHostEnrollmentByMachine` with a principal read from its own
enrollment row; `sessionAuthority` is read per beat from
`embeddedWorkspaceRuntimeSessionAuthority`, the same expression the runtime
app is composed from, so the declaration cannot drift from what is mounted.

**A.7 The tunnel replays onto loopback** — both tunnel owners
(`host-serving/src/serving.ts`, `claxedo-server/src/host-tunnel.ts`)
replay a relayed request as a fetch to the machine's own listener with
`loopbackReplayHeaders`
(`claxedo-server-core/src/platform/http/peer-address.ts`): the remote
browser's `Origin` and `Host` never reach the daemon's loopback gate. What
separates the replayed request from the machine's own user is decided at
ingress (F.2), never by its address.

## B. The client sees the machine and its workspace

**B.1 Boot** — `packages/claxedo-app/src/app/entry/browser-auth-startup.ts`
starts identity without gating `render()`; `CloudAuthGate` holds its
children while `loading`. The shell's `GET /api/claxedo/bootstrap`
(`packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts`)
is where the server states two facts the client cannot derive from a URL or
a build flag: `events.hostAggregate` (whether this composition serves the
host aggregate `wr/events`, F.2) and `host.enrollment` (this machine's
enrollment id, or `null` when unenrolled — `hostEnrollmentId:
hostServingEnrollmentId` in `app/local-app.ts`). The app caches both per
server (`setHostAggregateDeclaration`, `setSelfHostDeclaration` in
`src/platform/query/control-plane.ts`); the second is the `SelfHost` every
wire decision reads. A browser on the hosted app gets no declaration, which
is correct: no machine is behind it.

**B.2 Catalog** — `src/features/workspaces/data/workspace-catalog.ts` is the
one owner of the rail's inventory. `workspaceCatalogQuery` reads the
attached server's own `/project` when that server serves directories of its
own (`centralOwnsProjects`), and, for a signed principal, the control plane's
list once per relay host kind: `listControlPlaneWorkspaces` for
`provisioner` and for `machine`, through the account operations
`workspace.list.provisioner` / `workspace.list.machine` on the desktop or
`workspaceListUrl` elsewhere. Both spell the list query as
`GET /api/workspace?host=provisioner` / `?host=machine`
(`packages/claxedo-server/src/routes/hosted/workspace.ts` and
`workspace/routes/index.ts`), and the route answers `host=machine` by
filtering rows to `backing === "local-worktree"`. Each row states `backing`, `placement`, `remote_directory`,
`role`, `status` and `host_online`. `controlPlaneCatalogProjects` builds one
project per `project_id`; `controlPlaneRowKind` maps `backing` to a host
kind and back to the inventory word the daemon's own rows use, so the two
sources share one map, and `rowPlacement` keeps the placement's
`host_enrollment_id`. `mergeWorkspaceCatalog` drops a control-plane row for a
workspace the direct source already serves: reading it through its own
tunnel is a round trip to itself.

**B.3 Address** — a workspace on another host is addressed by its id
everywhere. `workspaceRowDirectory` keys the catalog entry as
`workspace:<id>`; the host's own path is location metadata
(`remote_directory`). `sessionRowDirectory`
(`src/platform/identity/workspace-address.ts`) applies the same rule to a
session row: a row with a signed workspace id carries `workspace:<id>`, a row
without one names a path on this machine. `workspaceRouteIdentity`
(`src/platform/identity/workspace-route.ts`) resolves `/w/<id>` to the
catalog row's own addressing directory, so panes, rail sections, terminal
scoping and every directory-scoped request name the workspace, never a
directory on another machine.

**B.4 Wire** — `src/platform/runtime/placement-wire.ts` is the only
translator between the control plane's words and the placement the app
reads: `inventoryHostKind` (the ATTACHED server's own inventory word `local` /
`cloud` → `self` / `provisioner`), `backingHostKind` (the control plane's
`cloud-vm` / `local-worktree` → `provisioner` / `machine`),
`controlPlaneRowPlacement`, and `placementWire(placement, self)`: a `self`
host is loopback; the provisioner is relay; a machine with no enrollment id
is `unreachable` (nothing is opened, the surface says the machine is
offline); a machine with one is loopback exactly when `self` is `enrolled`
with the same id, otherwise relay. The event target selection calls it
(`routeWorkspaceWire` in `src/app/integrations/claxedo-event-targets.ts`).
Observed residue: the runtime request path
(`src/platform/runtime/agent/workspace-runtime-request.ts`, driven by
`createTransport`'s `preferRelayOnLoopback`) and `src/platform/runtime/placement.ts`
still decide loopback-versus-relay from the server URL's shape plus the host
kind (`isLocalPersonalScope` in `server-transport.ts`: loopback URL and a
filesystem directory), not from `placementWire`; the plan records this as
unmet for two of the three paths.

## C. Connecting: the mint

`GET /api/workspace/:id/connection`
(`packages/claxedo-server/src/connections/routes/connection-routes.ts`) →
`hostedConnectionInfo` (`connections/hosted-connection-info.ts`) opens the
workspace through the authority and branches on `backing`. `local-worktree`
→ `hostTunnelConnectionInfo` (`connections/host-tunnel-connection.ts`): the
host must be live (`activeWorkspaceHost`, else 409
`workspace_host_offline`); the relay URL comes from the
workspace's home region; a Runtime Access Token is minted with the verified
actor, the workspace, the host id and the caller's workspace role, recorded
and audited, and the previous token revoked on a refresh. The answer carries
`relayUrl`, `runtimeAccessToken`, `tokenExpiresAt`, `role`, `backing`, and
`sessionAuthority` exactly as the host declared it on its beat (an
undeclared host yields none). `backing` is the only placement word the body
carries: `runtimeKind` restated it one-for-one and nothing parsed it. `cloud-vm` →
the sandbox is ensured and `sessionAuthority` is the fixed
`"managed-private"`.

The app parses it in `src/platform/runtime/agent/workspace-relay-connection.ts`
(`parseConnection` narrows `sessionAuthority` to `local` |
`managed-private`), and the single-writer connection authority
`src/features/workspaces/data/workspace-connection.ts`
(`acquireWorkspaceConnection`, `connectionPlacement`,
`workspaceRelayPlacement`) holds one ref-counted connection per workspace;
`WorkspaceScopeHost` (`features/workspaces/data/workspace-scope.tsx`) keeps
one lease per workspace scope however many panes show it. The mint names no
address of the machine itself, and `Placement["transport"]`
(`src/platform/runtime/placement.ts`) offers only `loopback`, `signed-web` and
`workspace-relay`, so every runtime request to a machine-placed workspace is
dialled at `relayUrl` under its Runtime Access Token. The laptop is never a
direct client target.

Relay-side, `packages/workspace-relay/src/cors-origins.ts` compiles one
origin matcher (`createOriginMatcher`, `DEFAULT_RELAY_APP_ORIGINS`) that both
`cloudflare.ts` and `bun.ts` stamp on browser-facing responses.

## D. Listing sessions: one source per host kind

`src/features/session/data/sync/session-source.ts` decides where a
workspace's sessions are read from, by the catalog row's host kind and
nothing else. `sessionSourceForWorkspace`: `self` and `provisioner` read the
attached server's own list (`fetchSessionListPage` →
`GET /api/control/session-list`); `machine` reads the workspace's own
runtime over the relay (`createTransport` with a `workspace-relay`
placement, `GET /session?roots=true`), paged from memory, with each row's
creator joined from the control plane's registry (`machineSessionOwners`,
because the runtime knows sessions and not people; a refused registry leaves
rows unowned rather than emptying the section). `projectSessionSource`
composes a project's sources — the central member plus one per machine-placed
workspace — and `composedSessionListPage` merges their pages, a runtime's row
winning over a central row for the same session. Every source writes the one
`shell.sessionList` cache entry through `applyFetchedSessionListPage`, so
readers, paging and the event appliers in `session-list.ts` are one
implementation; the rail's `createRailSectionSessionList`
(`src/app/workbench/rail/rail-section-session-list.ts`) refetches when a
section's source changes.

Rows from a machine source carry `workspace:<id>` (`sessionRowDirectory`).
Event ingress (`src/app/integrations/session-events/event-ingress.ts`)
resolves a frame's workspace through `sessionWorkspaceRuntimeRef`
(`src/platform/runtime/session-workspace.ts`) against the catalog before
addressing a row, and the catalog's positive identification of a local
workspace wins over a stale relay-shaped ref.

## E. Opening a session and creating one

**E.1 Open** — the rail row's route is `workspaceSessionRoute(workspaceId,
sessionId)`; every read under it is scoped by the workspace's addressing
directory (B.3) and travels the wire B.4 chose.

**E.2 Create** — `submit-create-session.ts`
(`src/features/session/composer/ui/`) reserves first only when
`managedSessionRegistration` is true, which `submitTransportForPlacement`
(`src/platform/runtime/transport.ts`) answers from the server's own
declaration: a control-plane session, or a catalog row whose
`session_authority` is `managed-private`. A daemon declares `local` on its
own loopback (`loopbackSessionAuthority: "local"` in
`packages/claxedo-local-server/src/app/start-local-server.ts`,
`embeddedWorkspaceRuntimeLoopbackSessionAuthority`), so its own window never
reserves, signed in or out. When it does reserve, `reservePrivateSession`
(`src/platform/runtime/private-session-reservation.ts`) posts
`/api/control/session-registrations/reserve`
(`packages/claxedo-server/src/routes/private-session-registration.ts`),
creates the session under the reserved id with the
`x-claxedo-session-registration-operation` header, and publishes the id to
the stream owner (`holdSessionEventScope`, F.1) before the first prompt.

On the runtime, `managedSessionLifecycle` in
`packages/workspace-runtime/src/routes/session-core.ts` decides per request:
the private lifecycle (a reservation before the create, a registered
creator, a durable turn lease through `acquireManagedPromptLease`) applies
when the policy is `managed-private` AND `sessionRequestProvenance(c)` is
`relay-replayed`; a loopback-direct request creates with no reservation and
no round trip. A relayed create with no operation id is refused 400
`session_reservation_required`.

## F. Live streams: one workspace stream, one scope owner

The workspace runtime serves one stream, `GET /api/wr/events`
(`packages/workspace-runtime/src/routes/events.ts`). Every data frame is
`{ directory, payload }`: the projected client-presentation events, the
`subagent.updated` and `goal.*` runtime-channel events, and the workspace's
control frames from `workspaceRuntimeBus` (`pty.*`, `process.*`,
`agent.lifecycle`, `session.lifecycle`). The control plane's own `GET
/api/cp/events` carries notices only and never a session's frames.

**F.1 Scope** — `src/platform/runtime/session-event-scope.ts` owns "which
session's frames must be streaming, and are they": `holdSessionEventScope`
from the composer, `setSessionEventRouteScope` from the route
(`src/app/integrations/claxedo-events.tsx`), `sessionEventScopeId()` settled
by value; the reader registers each lane (`registerSessionEventStreamLane`,
`HOST_AGGREGATE_LANE`) and reports it open with the session it is scoped to.

**F.2 Targets and arms** — `claxedoEventStreamTargets`
(`src/app/integrations/claxedo-event-targets.ts`) opens, on a loopback
surface, the daemon's `cp/events`, the hosted control plane's through the
account bridge on a signed desktop, and — only when the server declared
`events.hostAggregate` — the host aggregate `wr/events` with no workspace
named, which carries every embedded runtime's frames on one connection. A
route's workspace gets its own `wr` target only when `routeStreamDecision`
says `scoped`: never while the declarations are pending, never for a
placement whose wire is `unreachable`, and not for a workspace the aggregate
already carries. The daemon's aggregate handler
(`packages/claxedo-local-server/src/shell/host-events.ts`) is refused to any
reader that is not loopback-direct.

The runtime decides the arm from the REQUEST, not from the composition.
`authorizeSessionEventScope`
(`packages/workspace-runtime/src/routes/session-event-privacy.ts`): a policy
that is not `managed-private` reads the whole stream; a request whose
provenance is `loopback-direct` reads the whole stream too, because that is
the machine's own user; a `relay-replayed` request with no `sessionID` asks
`policy.authorizeHost` (the control plane's `host_read`) and, admitted,
reads unscoped under a workspace lease, seeing the session-less frames and,
session by session, only what the session authority grants; refused, it is
answered 403 `workspace_event_stream_denied`, the cue to reopen
`?sessionID=` for one session under a lease (`authorizeStream`; 403 there is
`session_event_stream_denied`). A subagent child's frames are scoped as its
parent's.

Provenance is stamped once at the daemon's ingress,
`resolveIngressProvenance`
(`packages/claxedo-local-server/src/workspace/runtime-dispatch/ingress-provenance.ts`),
which the desktop daemon mounts with `verifyRelayIngress: true`
(`start-local-server.ts`): a bearer that verifies as a Relay Host Token
against the relay's key set (`localHostRelayActor` in
`deployments/local/host-session-authority.ts`) stamps `relay-replayed` with
the actor, org and role; a request that says it came through the relay
(`x-forwarded-by: workspace-relay`) but does not verify is refused 403
`relay_actor_unverified`, never treated as local; a request that is neither
verified nor loopback is refused 403 `workspace_request_not_loopback`; only
an unmarked loopback request is `loopback-direct`. The daemon's policy is
`localHostSessionAccessPolicy` — `remoteWorkspaceSessionAccessPolicy` with
`requireActor: false` and the control plane's authority URL read per call
from the heartbeat ack — so it declares `managed-private` while its own
user keeps the local lifecycle. Its `adoptRefusedSession` claims a session
the control plane has no row for, on the owner's own first relayed read of
one the embedded runtime actually holds, so sessions created before remote
access was turned on become reachable without registering anything the
owner never opened remotely.

Per session, the authority is the same on both stores
(`hasPrivateAccess` in
`claxedo-server-core/src/authority/adapters/sqlite/private-session-authority.ts`,
`actorSessionAccessSql` in
`claxedo-server/src/authority/adapters/d1/session-authority.ts`): standing in
the session's organization is necessary and never sufficient; then the
creator, a participant, or a share grant — `follow` reads and streams,
`send` also drives the agent's turn, and a `session_control` write drops the
share branch. No rank on the organization or the workspace admits anyone;
the workspace's owner is not special.

**F.3 Frame address** — every frame a runtime publishes names its own
filesystem directory. `eventStreamFrameAddress` translates frames received
on a machine's or the provisioner's stream to `sessionRowDirectory`'s
`workspace:<id>` at the stream boundary, once; frames on the aggregate and on
a `self` workspace's stream pass through unchanged, because that path is
this machine's.

**F.4 Projection** — the host projects a turn's raw harness frames through
`createClientPresentationProjection`
(`packages/agent-event-runtime/src/projections/client-presentation`) before
they reach the wire; the client projects nothing. The reply id is minted
from the prompt by `assistantMessageIdForTurn`
(`packages/agent-event-runtime/src/contracts/turn-message-ids.ts`,
`${userMessageId}_r`), and `packages/workspace-runtime/src/session/service.ts`
announces the assistant row under it for a turn nobody on the client
started. A retarget restarts only a session-scoped stream; a workspace-wide
cursor survives.

The result: a turn started on the machine renders in an attached pane on
another device delta by delta, and a turn started remotely streams its own
reply from the moment the session exists.

## G. Terminals and configuration

A terminal opened remotely is created on the host (`POST /api/wr/pty`,
`packages/workspace-runtime/src/routes/pty.ts`); a managed request must name
the session it belongs to (400 `pty_session_id_required`), and its
`pty.created` / `pty.stream` frames ride the workspace bus scoped to that
session (F.2). `denyWorkspaceViewers` (`routes/workspace-role.ts`) refuses a
viewer's PTY, process and Git writes by the role on the relay token.
Provider configuration the owner pushed to a machine reaches the daemon over
`PUT /api/claxedo/host-provider-config`
(`packages/claxedo-local-server/src/workspace/host-provider-config-routes.ts`),
a loopback-only surface the relay's `hostServingSurface` denies; Settings acts
on a chosen (workspace, harness) scope (`src/features/settings/scope/*`), and
a harness reports the model it resolved (`resolvedModel` in
`src/features/session/harness/profile.ts`).

## H. Authority on the runtime side

`managedWorkspaceSessionAccessPolicy`
(`packages/workspace-runtime/src/session-access-policy.ts`) is built from one
all-or-nothing `ManagedSessionAuthority` bundle — read, write, stream,
register, and the three turn-lease members — and `sessionAuthority` is
`managed-private` exactly when the bundle exists. That marker is a
DECLARATION: the control plane records it and the client reads it to know
whether to reserve. The decider of registration, turn admission and event
privacy is the request's provenance, `sessionRequestProvenance`, read at the
three sites named in E.2 and F.2. A session-less write is the workspace's
own and the relay role answers for it (`authorizeManaged`: below `editor` is
403 `workspace_write_forbidden`); a session-scoped write is the session
authority's question, carried with its class (`sessionAccessWriteClass`:
`agent_turn` for prompt, permission and question responses, and abort;
`session_control` for everything else), because a `send` share admits
someone the workspace ranks below editor or not at all. Stream authorization
and lease minting have one owner, `authorizeRuntimeSessionStream` in
`packages/claxedo-server/src/routes/runtime-session-authority.ts`.

A person's workspace role is computed, never handed to one person by
another. `workspaceRoleForUser`
(`claxedo-server-core/.../sqlite/workspace-authority-store.ts`) answers
`owner` for the workspace's owner and otherwise the highest of a direct
`project_memberships` row, `workspaceOrgRole` (the person's org role, with
an org member's `viewer` withheld when `org_member_visible` is 0) and the
best `team_project_grants` row of a team they are on in that org;
`workspaceAccessSql` (D1 `workspace-authority.ts`) takes the same `max` in
one query and joins the assignment's enrollment in as `host_enrollment_id`.
That role decides who can SEE the placement and the workspace-scoped
surfaces (files, terminals, processes, git); it is what lets a teammate be
offered a session share. An organization is a grouping of people and grants
nothing on a machine, a runtime or a folder.

The role stops at the session. The only grant one person makes to another is
a session share (`POST /api/control/sessions/:id/shares`, level `follow` or
`send`), and it is the whole admission (F.2). Only the session's creator
may grant or revoke its shares, and only to a member of the session's
organization.

## I. How it is proven

Nothing in this list was run while this document was written; each entry
names the file and what it claims to cover.

- **Tier M** (`packages/claxedo-app/e2e/helpers/mock-runtime.ts`, contracts
  in `e2e/helpers/contracts/*`) mocks the whole server. Its control-plane
  rows carry `backing`, `placement { host_enrollment_id, directory }`,
  `remote_directory` and `host_online`, and its connection mint carries
  `sessionAuthority`. `e2e/playwright/core-host-tunnel-workspace.spec.ts`
  drives a machine-placed workspace against it.
- **Daemon probe** (`packages/claxedo-local-server/src/app/desktop-session-authority.test.ts`)
  runs the same request twice against a real `startLocalServer`, once with the
  relay's marks and once without, with the session authority and the relay
  bearer verification faked, and asserts which of them the daemon consults.
- **Tier R** (`CLAXEDO_TIER_REAL_E2E=1`): `e2e/playwright/real-host-tunnel-relay.spec.ts`
  with `packages/claxedo-server/src/signed-browser-relay-fixture.mjs` — a
  real relay, a real host tunnel, a real server with its embedded runtime, a
  scripted model and a real browser with zero route mocks: register and
  tunnel-up, health, file and PTY through the relay lane, a terminal round
  trip, attach with live deltas, viewer-role denial, tunnel pause and resume.
  `web-signed-host-tunnel.spec.ts` runs the shared signed-web journeys against
  the same fixture; `desktop-signed-embedded-shared.spec.ts` and
  `real-desktop-signed-cloud.spec.ts` drive the packaged desktop's account
  and remote-access surfaces; `real-connect-host.spec.ts` runs a real
  `claxedo connect` machine through enrollment, serving, revocation and
  provider-config push.
