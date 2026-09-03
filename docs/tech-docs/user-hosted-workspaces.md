# User-hosted workspaces: full access from the web over the relay

A **user-hosted workspace** is a directory on a machine the user (or a
teammate) owns and runs Claxedo on — the desktop app or `claxedo up`. The web
client reaches it only through the Workspace Relay: no central sandbox sits
behind it. Everything the desktop can do against that workspace, the web client
does the same way, and the machine's own runtime stays the authority for its
sessions, streams and terminals.

This document follows one user from enrolling a machine to attaching to a
running session from the browser, naming the owner of each step. Three
surfaces read the same code: the local unsigned surface (desktop or the
daemon's own loopback page), the signed desktop, and the web client.

## A. Enrollment: the host declares what it serves

**A.1 Desktop** — `packages/claxedo-desktop/src/main/host-connector/*`.
`hostConnector.start()` enrolls the machine with the control plane through the
host connector child (`child-supervisor.ts`, `host-connector-entry.ts`). The
connector's heartbeat carries the workspace ids the machine serves and, outside
the consent signature, `sessionAuthority` — the composition of the runtime the
machine serves. The desktop reads that declaration from its daemon's
`GET /api/claxedo/host-serving` (`packages/claxedo-local-server/src/workspace/user-hosted-serving.ts`),
which reports `embeddedWorkspaceRuntimeSessionAuthority()` from
`deployments/local/embedded-workspace-runtime.ts`: the same expression the
runtime app is composed from, so the declaration cannot drift from what is
mounted. The desktop daemon composes the unbound local policy and declares
`local`.

**A.2 Self-hosted node** — `packages/claxedo-server/src/deployments/self-hosted-node/app.ts`
composes `embeddedManagedPrivateSessionPolicy` and passes the same
`sessionAuthority` producer into `createRemoteAccessService`
(`remote-access-service.ts`), which declares it on every beat. That host
declares `managed-private`.

**A.3 Control plane** — `packages/claxedo-server/src/routes/hosted/host-enrollment.ts`
records the beat through `WorkspaceAuthority.heartbeatHostEnrollment`. Each
authority adapter (`authority/adapters/d1`, `claxedo-server-core/.../sqlite`,
`convex/hostEnrollments.ts`) stores `session_authority` on the host enrollment
row; `activeWorkspaceHost` returns it. The latest beat assigns the value: a host
that stops declaring is undeclared again. The control plane never guesses a
runtime's composition; `hostSessionAuthority()` in
`packages/claxedo-server-core/src/platform/auth/authority.ts` is the one
narrowing.

**A.4 Host tunnel** — `packages/claxedo-server/src/user-hosted-tunnel.ts` and
the local daemon's serving path both start their tunnel with
`loopbackReplayHeaders` from
`packages/claxedo-server-core/src/platform/http/peer-address.ts`. A remote
browser's `Origin` and `Host` never reach the host's own loopback gate
(`isLoopbackLocalRequest`); the relay's tunnel replays the headers the gate
requires, from that one owner.

## B. The web client sees the machine and its workspace

**B.1 Boot** — `packages/claxedo-app/src/app/entry/browser-auth-startup.ts`
starts the identity provider without gating `render()`. Identity is a signal
(`useAuthSession().status()`: `loading` → `signed` / `anonymous`); a loopback
central is anonymous by contract and a descriptor that cannot be loaded is
anonymous with a reason the login surface shows. `CloudAuthGate` holds its
children while `loading`.

**B.2 Catalog** — `src/features/workspaces/data/workspace-catalog.ts` is the
one owner of the sidebar's inventory. `workspaceCatalogQuery` reads
`GET /api/workspace?access=cloud` and `?access=user-hosted` from the control
plane (`packages/claxedo-server/src/workspace/routes/index.ts`, mirrored by
`routes/hosted/workspace.ts`) and folds them with the local daemon's `/project`
list. `controlPlaneCatalogProjects` builds one project per `project_id`; each
row states its own kind (`access`), role, and `host_online`.

**B.3 Address** — a relay-backed workspace is addressed by its id everywhere.
`workspaceRowDirectory` keys the catalog entry as `workspace:<id>`; the host's
own path is location metadata (`remote_directory`). The same rule for session
rows is `sessionRowDirectory` in
`src/platform/identity/workspace-address.ts`: a local row keeps this machine's
path, a cloud or user-hosted row carries `workspace:<id>`. The route owner
`workspaceRouteIdentity` (`src/platform/identity/workspace-route.ts`) resolves
`/w/<id>` to that address, so panes, rail sections, terminal scoping and the
`x-opencode-directory` header all name the workspace, never a directory on
another machine.

**B.4 Kind** — `src/platform/runtime/agent/workspace-kind.ts` is the only
source of "what kind of workspace is this" (`workspaceKind`,
`isUserHostedWorkspaceKind`, `isRelayBackedWorkspaceKind`). Nothing else
compares the string.

## C. Connecting: the mint

`POST /api/workspace/:id/connection` (`packages/claxedo-server/src/connections/user-hosted-connection.ts`,
`cloud-connection.ts`, `hosted-connection-info.ts`) answers with the relay URL,
a runtime access token, the caller's role, and `sessionAuthority` — for a
user-hosted workspace, exactly what the host declared in A; undeclared yields no
key. The app parses it in
`src/platform/runtime/agent/workspace-relay-connection.ts` (`parseConnection`)
and the single-writer connection authority in
`src/features/workspaces/data/workspace-connection.ts` holds it per workspace
(`workspaceSessionAuthority()`). `WorkspaceScopeHost` keeps one connection
lease per workspace scope however many panes show it.

Relay-side, `packages/workspace-relay/src/cors-origins.ts` compiles one origin
matcher from the deployment's allowed origins; both the Cloudflare worker
(`cloudflare.ts`) and the Bun server (`bun.ts`) stamp every browser-facing
response with it, tunnel responses included.

## D. Listing sessions: one source per workspace kind

`src/features/session/data/sync/session-source.ts` decides where a
workspace's sessions are read from. `sessionSourceForWorkspace` maps the
catalog row's kind to a source: the central server for local and cloud
workspaces, the workspace's own runtime over the relay
(`GET <relay>/workspaces/<id>/session?roots=true`) for a user-hosted one.
`projectSessionSource` composes a project's sources (central plus each
user-hosted member), so the rail's project view and its workspace view show the
same sessions. Every source writes the one `shell.sessionList` cache entry
through `applyFetchedSessionListPage`, so readers, paging and the event
appliers in `session-list.ts` are one implementation. The rail's
`createRailSectionSessionList` (`src/app/workbench/rail/rail-section-session-list.ts`)
refetches when a section's source changes; the query's sort is the order
authority, and the default order is by activity.

Rows from a user-hosted source carry `workspace:<id>` and the row's role and
host labels. Event ingress (`src/app/integrations/session-events/event-ingress.ts`)
resolves a frame's workspace id through `sessionWorkspaceRuntimeRef` against
the resolved catalog before addressing a row, so a caller-chosen user-hosted
id addresses by workspace while a local association keeps its local row.

## E. Opening a session and creating one

**E.1 Open** — the rail row's route is `workspaceSessionRoute(workspaceId, sessionId)`;
the pane reads messages through the relay lane
(`<relay>/workspaces/<id>/session/<sessionId>/message`), addressed by the
workspace, never by the central server with a host path.

**E.2 Create** — `src/features/session/composer/ui/submit-create-session.ts`
reserves a private session id at the control plane
(`src/platform/runtime/private-session-reservation.ts` →
`POST /api/control/session-registrations/reserve`,
`packages/claxedo-server/src/routes/private-session-registration.ts`), creates
the session under that id on the runtime, publishes the id to the stream owner
(F), waits for the session-scoped lanes to report open, and only then dispatches
the prompt. The runtime creates the session under the reserved id
(`packages/workspace-runtime/src/routes/session-core.ts`).

## F. Live streams: two lanes, one scope owner

The workspace runtime publishes two streams:

- the **workspace bus**, `GET /api/wr/events` (`packages/workspace-runtime/src/routes/events.ts`):
  workspace-scoped lifecycle — `pty.*`, `process.*`, `agent.lifecycle`,
  `session.lifecycle`;
- the **runtime-events lane**, `GET /api/wr/runtime-events?parentSessionId=<id>`
  (`routes/runtime-events.ts`, contract v7 in
  `packages/agent-event-runtime/src/contracts/agent-runtime-event.ts`): a
  turn's message parts and deltas.

**F.1 Scope** — `src/platform/runtime/session-event-scope.ts` is the one owner
of "which session's streams must be open, and are they open". The composer
publishes a created session's id (`holdSessionEventScope`); the route publishes
the session it names (`setSessionEventRouteScope`, from
`src/app/integrations/claxedo-events.tsx`); `sessionEventScopeId()` settles by
value, so a change of writer with the same session does not retarget the lanes.
Both lanes register with it and report open with the session they are scoped
to; a workspace-wide stream satisfies any session.

**F.2 Targets** — `claxedoEventStreamTargets` in
`src/app/integrations/claxedo-event-targets.ts` derives the bus stream from
the connection's declared `sessionAuthority`: a `local`-authority host serves
the workspace-wide bus, so a terminal or process route with no session opens
it; a `managed-private` runtime serves session-scoped streams only, which the
runtime enforces with `authorizeSessionEventScope`
(`packages/workspace-runtime/src/routes/session-event-privacy.ts`). An
undeclared authority opens no workspace stream and says why. The central
stream (`/api/claxedo/events`, one handler on three spellings) is read on a
loopback central always and on a signed-web central only with an account.

**F.3 Frame address** — every frame from a user-hosted host names the host's
own filesystem directory, because the producer knows only its own path.
`eventStreamFrameAddress` addresses frames received on a relay-backed
workspace's streams by that workspace (`sessionRowDirectory`) at the stream
boundary, once, before they reach the bus or the ingress; local and central
streams pass through unchanged.

**F.4 Projection** — the runtime-events lane is projected by
`src/app/providers/global-sdk/runtime-event-projection.ts` through
`createOpencodeCompatProjection` (`packages/agent-event-runtime/src/projections/opencode-compat/projection.ts`).
For a viewer attached to a turn another client drives, the projection announces
the assistant row before its first part, parented on the user message the turn
message-id convention names (`packages/agent-event-runtime/src/contracts/turn-message-ids.ts`,
the one owner of `${userMessageId}_r`, used by every minter and resolver). The
OpenCode publisher (`packages/agent-sdk-runtime/src/harnesses/opencode/events.ts`)
stamps every frame with the turn's stable reply id, carries the prompt as a
user-message delta, and closes the turn it opened. A retarget restarts only the
session-scoped lane; the workspace-wide cursor survives.

The result: a turn started on the desktop renders in an attached web pane delta
by delta, and a turn started from the web streams its own reply from the moment
the session exists.

## G. Terminals and everything else

A terminal opened from the web is created on the host (`POST /api/wr/pty`,
`packages/workspace-runtime/src/routes/pty.ts`) for the workspace's session;
its `pty.created` and `pty.stream` frames ride the workspace bus (F.2) and
register it with `src/features/terminal/providers/provider.tsx`. Provider
configuration is written where it is read
(`PATCH /api/wr/provider-config`, `routes/provider-config.ts`); Settings acts on
a chosen (workspace, harness) scope (`src/features/settings/scope/*`); a
harness reports the model it resolved (`{ options, resolvedModel? }`) and only an
explicit pick is remembered (`src/features/session/harness/harness-store.ts`).

## H. Authority on the runtime side

`managedWorkspaceSessionAccessPolicy` (`packages/workspace-runtime/src/session-access-policy.ts`)
is built from one all-or-nothing `ManagedSessionAuthority` bundle: read, write,
stream, register, and turn admission. A composition that omits any of them does
not compile; `sessionAuthority` is `managed-private` exactly when the bundle
exists. Stream authorization and lease minting have one owner,
`authorizeRuntimeSessionStream` in
`packages/claxedo-server/src/routes/runtime-session-authority.ts`; the remote
route and the embedded managed policy both call it, and a
`SessionStreamLeaseBinding` names how the holder proved identity so a renewal
re-checks the right thing. Workspace shares (`workspace/routes/share-routes.ts`,
mounted by every hosted composition) grant viewer, editor or admin roles; the
relay token carries the role, and a viewer's writes and PTY requests are
refused by the runtime.

## I. How it is proven

- **Tier M** (`packages/claxedo-app/e2e/helpers/mock-runtime.ts`) mocks the
  whole server, with every route bound to the real contract in
  `e2e/helpers/contracts/*` (row types taken from the D1 authority, the
  reservation route's own validation, provider config driven through the real
  router, the central stream on the three spellings the servers mount). Its
  user-hosted frames carry a host filesystem directory, as the real daemon's do.
- **Tier L** (`e2e/playwright/live-user-hosted-relay.spec.ts` with
  `packages/claxedo-server/src/signed-browser-relay-fixture.mjs`) runs a real
  relay, a real host tunnel, a real server with its embedded runtime, a scripted
  model and a real browser with zero route mocks: register and tunnel-up,
  health, file and PTY through the relay lane, attach with live deltas, tunnel
  pause and resume, viewer-role denial, and a terminal round trip.
- **Live**: the desktop app enrolled against the staging control plane and the
  web client driving that workspace through the Cloudflare relay.
