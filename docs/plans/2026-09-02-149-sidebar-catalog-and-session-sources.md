# 2026-09-02-149 — One catalog, one session source per workspace kind

Status: PLANNED. Owner: app (`packages/claxedo-app`), with one runtime route
and one control-plane route change.

## Why

The sidebar is where the three hosting shapes meet: the desktop reading its
own daemon, the web reading the user's own cloud and user-hosted workspaces,
and the web reading a workspace a teammate's machine serves. Today it is fed
by more sources than it has authorities, and the defects of the last two days
(an empty rail that flashes and vanishes, a 2.6 s session list, per-turn
control-plane reloads) all come from that.

## Current flow (observed in code)

**Projects.** `RailSidebar` renders `shell.projects` =
`layout.projects.list()` (`app-shell-state.ts:84`), the `projectCatalog` of
two inputs: the `controlPlane.projects` query and the persisted
`server.projects` store (`layout.tsx:342-348`, `connection/server.tsx`).
The query has three writers with different semantics:

1. `bootstrapGlobal` writes the bootstrap payload's projects, once through
   `setProjects` (alias-merged) and once raw (`bootstrap.ts:265-266`); the raw
   write wins.
2. `loadSessionInventorySnapshot` writes the signed snapshot's projects: a
   full replacement off loopback (`provider.tsx:227`), an additive merge on
   loopback (`:260`).
3. `reloadProjects`/`ensureProject` write `/project` again (`:492-514`), and
   `global` SSE events patch it (`event-ingress.ts:188-201`).

The persisted store only ever receives absolute paths (`validWorktree`), so
on the hosted web it holds nothing the catalog can use, and the rail is
exactly the query's data: any writer that lands `[]` empties the rail.

**Sessions.** Every open block owns its rendered list via
`sessionListQueryOptions` against `/api/control/session-list` (loopback:
`/api/claxedo/session-list`) (`rail-sidebar.tsx:1894-1920, 2188-2208`). A
second source, the `sessionInventory` snapshot, is loaded on mount from
`/api/workspace?access=…` plus `/api/control/sessions?workspaceId=` per
workspace (`inventory-source.ts:264-267, 340-396`) and used only to seed the
blocks' open state and preview rows. For a user-hosted workspace the registry
inventory is empty by design, and the rendered list is served by the control
plane pulling from the host (`server/src/session/list.ts:50-99`): client →
control plane → relay → host, 2.6 s cold. Transcripts and everything else
about one session already go client → relay → host.

**Freshness.** `session.lifecycle` invalidates every list; `session.share.*`
invalidates lists and inventory; a settled turn on a signed workspace reloads
the whole inventory through the control plane (`session-controller.ts:1013-
1036`); global project events patch the catalog.

**Role and reachability** for a shared user-hosted workspace live in
`workspace-connection.ts`, populated only when a pane acquires the
connection; the rail shows no role or online state for a workspace that was
never opened, and the "Shared" badge means "my machine publishes this", not
"shared with me".

## Surfaces and sources (two independent axes)

The surface decides who the central server is and who the principal is; the
workspace decides where its sessions live. The rail must treat them as
independent axes.

| surface | central server | principal | catalog |
| --- | --- | --- | --- |
| local unsigned (desktop shell, or a browser tab on the loopback page) | the daemon | none | daemon `/project` |
| local signed (desktop, or a loopback tab whose daemon holds the account) | the daemon, proxying the control plane through the account bridge | the daemon's account | daemon `/project` + control-plane workspace list (cloud, user-hosted) |
| hosted web signed | the control plane | the browser session | control-plane workspace list |

| session source | reached via | on which surfaces |
| --- | --- | --- |
| own machine, direct | loopback daemon | local unsigned, local signed |
| cloud workspace | control-plane registry; runtime over the relay | local signed, hosted web |
| own machine, over the relay | relay connection, owner role | hosted web |
| teammate's connected machine | relay connection, shared role | local signed, hosted web |

Rules:

- **Dedupe by workspace id, prefer direct.** On a signed desktop the same
  workspace appears in the daemon's `/project` and in the control plane's
  user-hosted list (published by this machine). The catalog merges them into
  one row and reads sessions from the daemon, never through its own tunnel.
- **Own-over-relay and teammate-over-relay are one source.** They differ only
  in the role the relay token carries; affordances follow the role.
- Open question: whether an unsigned surface can ever reach a cloud session.
  No principal exists to present to the control plane, so the model assumes
  not; if a case exists it gets its own row here before step 1 starts.

## Target model

Three authorities, one owner each, and the rail reads only through them.

**Catalog** (`WorkspaceCatalog`): the list of workspaces the signed principal
can see, with `kind` (`local | cloud | user-hosted`), `role`, project
grouping, and for user-hosted the host's lease state. One query, one writer:

- desktop / local: the daemon's `/project` (local workspaces) plus, when
  signed in, the control plane's workspace list for cloud and user-hosted;
- hosted web: the control plane's workspace list only (`/api/workspace?
  access=cloud|user-hosted` already carries kind, role and host state).

The bootstrap payload stops carrying projects; the persisted sidebar store
keeps only user intent (order, collapsed, closed) keyed by workspace id, and
is never a data source. `sessionInventory`'s project side is deleted.

**Session source** (`SessionSource`), chosen by `catalog.kind` and nothing
else:

- `local`: the daemon's session list (`/api/claxedo/session-list`), as now;
- `cloud`: the control plane's registry list (`/api/control/session-list`),
  as now, the control plane being the authority for cloud sessions;
- `user-hosted`: the runtime's `/session` list over the relay connection the
  app already holds, one hop, role enforced by the relay token. Own and
  shared workspaces are the same source; the role only gates affordances.

The control plane's `pullHostedControlSessionList` and the app's
`/api/control/sessions?workspaceId=` inventory calls are removed with it.

**Live updates**: each workspace's event stream (already open for relay-
backed workspaces, the daemon's for local) carries `session.created/updated/
deleted`; the source applies them to its own list. No list invalidation on
`session.lifecycle`, no inventory reload on settled turns, no polling.

**Role and reachability** come from the catalog row (role, host lease) so a
shared workspace shows "viewer · host offline" before any pane opens; the
connection store keeps only live placement for open panes. The "Shared"
badge is split into "published by this machine" (desktop) and "shared with
you by <owner>" (any surface).

## Steps and definition of done

1. **Catalog owner.** `features/workspaces/data/workspace-catalog.ts` owns
   the query; `bootstrap.ts` no longer writes projects; `provider.tsx`'s
   three project writers are deleted; `server.projects` holds intent only.
   DoD: one `setQueryData` site for the catalog in the app; the rail on
   `/marketplace` shows all workspaces within one catalog round trip;
   `bun test src/app/providers src/features/workspaces` green; a test proves
   an empty or failed catalog refetch never replaces a populated catalog.
2. **Session source per kind.** `features/session/data/sync/session-source.ts`
   with the three implementations; `ProjectBlock`/`WorkspaceBlock` read the
   source; `sessionInventory` reduced to open-state memory or deleted.
   DoD: user-hosted list served over the relay in one hop (probe: no
   `/api/control/session-list` call for a user-hosted workspace; list ≤ 0.6 s
   cold measured in the browser); `pullHostedControlSessionList` deleted
   from the server with its tests moved to the runtime's `/session` route.
3. **Live updates.** Sources subscribe to their workspace stream; delete the
   `session.lifecycle` list invalidation and the settled-turn inventory
   reload. DoD: creating a session from the desktop appears in the web rail
   without any list refetch (probe shows zero list requests after the
   event); the app's `sdkImportingFiles` and debt baselines do not grow.
4. **Role and reachability in the rail.** Catalog rows carry role and host
   lease; rail renders "viewer/editor", "host offline" per row. DoD: a
   workspace shared by another account renders its role and offline state
   with no pane open (Tier M mock plus one live check with a second
   account).
5. **Re-verify** the seven requirements of plan 148 on the hosted app after
   steps 1–4, with numbers next to the release-57 baseline.

Out of scope here: send-path collapse and session-open batching (plan 148's
performance follow-up); Durable Object placement.

## Execution log

- 2026-09-02, steps 1–4 landed: `867a20854f` (catalog owner), `b4cb2589ae`,
  `4db2c6015e` (session source per kind, event-applied lists, role and host
  state in the rail, control plane 409 for a user-hosted list). Two runtime
  gaps remain, with owners:
  - `session.deleted` does not exist on the user-hosted path:
    `workspace-runtime/src/routes/session-core.ts` `SessionLifecycleEvent`
    has no delete phase and `DELETE /session/:id` publishes nothing, so a
    session deleted on the host leaves the web rail only on the next fetch.
    Owner: workspace-runtime lifecycle events.
  - No stream is open for a relay-backed workspace without an open pane:
    `app/integrations/claxedo-events.tsx` `claxedoEventStreamTargets`
    deliberately limits observation to the route's session. Live rail rows
    for the other workspaces need a role-scoped per-workspace stream on the
    runtime (list-level events only), then the app subscribes per visible
    catalog row. Owner: workspace-runtime events + the events integration.
