# Session seen state: a per-reader fact on the server

Owner: this chat. Scope: the rail's finished and failed dots, the session list's `lastTurn`, a per-reader `seenAt`, and status and attention for sessions that are not open, with no event missed. Status: planned, not started; the owner accepted the three decisions on 2026-10-02. The server contract changes below still need the owner's sign-off before implementation (`packages/claxedo-app/AGENTS.md`, "Today's server").

## Owner rulings (2026-10-02)

- Seen is a fact about one reader and one session. It lives on the server, not in the app's memory.
- Unsigned local mode is one user (`LOCAL_USER_ID = "local"`, `claxedo-server-core/src/platform/auth/local-identity.ts`). It needs no per-user identity, but its seen state must survive a reload and an app or daemon restart.
- Keep the protocol shape: a snapshot field on the list item plus a live event, as status does today. No new transport.
- The app does not hold a content stream for sessions that are not open. It must still miss no status or attention change for any session it may read: running, finished, failed, waiting on you.

## Today (observed)

### Status

1. **Snapshot.** `src/server/session-list.ts` reads `/api/claxedo/session-list` on loopback (`claxedo-local-server/src/session/routes/meta-routes.ts:220` → `session-list-page.ts`) or `/api/control/session-list` hosted (`claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts:585` → `session/list.ts` → D1 `readD1SessionPage`). Each item carries `status { kind: idle|busy|retry|recovering, awaitingInput, backgroundWork }`; `listedStatusFromListItem` (`wire/session-row.ts`) maps it. The daemon reads it live from the mounted runtimes at request time. Hosted reads the D1 `sessions.status/status_at/awaiting_input` columns, written only by a machine daemon's `POST /api/claxedo/host/session-rows` (debounced 250 ms, `session-rows-publisher.ts`). A cloud sandbox runtime writes no rows, so a cloud session's hosted status is never set.
2. **Live.** `session.status`, `session.idle`, `session.error` and `session.background-work` frames on `/api/wr/events` become `statusChanged` (`wire/frames.ts` `activityEvent`) and update the row through `dispatchServerEvent` → `list.apply`.
3. **`lastTurn`** (`AgentTurnOutcome`, `agent-runtime-contract/src/sessions.ts:138`) is computed by the runtime on each session read from `runtime_journal` (`session-core/src/store.ts` `lastTurn()`). It is not stored in `claxedo_session_meta` (`sessionMetaSyncRow` drops it) or in D1 `sessions`, so a list item never carries it (`src/session/README.md`, reconcile rule 2).

### Which sessions the app hears live

| Placement | Stream | Unopened sessions heard live |
|---|---|---|
| Local folder or worktree (desktop, signed or not) | daemon `cp/events` + host aggregate `wr/events` | yes |
| Cloud workspace (owned) | `wr/events?sessionID=` per open session (`placement-streams.ts`, attached by `transcript/store.ts:92`, up to `OPEN_SESSION_LIMIT = 8`) | no |
| Another machine (owned) | same | no |
| Shared with me | same, on a session-scoped token (`workspace-relay-protocol` `sessionScopeReaches`) | no, and the token cannot reach more |
| Web, signed in | hosted `cp/events` (the `LiveSyncRoom` admits only `session.share.changed`) | no |

An unopened remote row changes only on a list re-read: `streamGap`, `sessionsChanged` (session added or removed, share changed) or the rail's Retry. Its spinner and dots are stale until then.

The runtime already serves an unscoped arm of `wr/events` to a principal its workspace authority admits (`session-core/src/routes/events.ts`, managed runtimes through `workspace-runtime/src/remote-session-authority.ts` `authorizeHost`, lease minted by `host_read` in `claxedo-server/src/routes/runtime-session-authority.ts`), filtered per session to what that principal may read. The app used it until `a2294048a1` (2026-10-01), which removed the workspace arm from `placement-streams.ts` without a stated reason; owned remote placements now hold a workspace-scoped relay token again (`relay.ts`, `transport.ts`). This plan does not use that arm: it carries every session's content to deliver a few status fields.

### Seen

`SessionStores.unseenOutcomes` (`9c9db1ee66`) is an in-memory store in the app. `AttentionAlerts` raises `finished` or `failed` on a live off-screen turn end and clears it when the route opens the session. It is lost on reload, never set for a turn that ended while the app was closed, never set for unopened remote sessions (no live frames), and not shared across a user's devices.

## Design

Unseen is derived, never stored: a row is unseen when `lastTurn.completedAt > (seenAt ?? 0)` and the session is not working, waiting or running in background. `lastTurn.status` picks the dot: `completed` → grey `done`, `failed` → blue `error`, `cancelled` → none.

| Fact | Owner | Per reader | Snapshot | Live |
|---|---|---|---|---|
| `status`, `awaitingInput`, `backgroundWork` | the runtime | no | list item (today) | `session.status.changed` notice on `cp/events`, to every principal who may read the session |
| `lastTurn { status, completedAt }` | the runtime that ran the turn | no | list item | the same `session.status.changed` notice |
| `seenAt` | the reader's seen store | yes | list item, joined on the requesting principal | `session.seen` notice on `cp/events`, visible only to its reader |

No event is missed because the snapshot is complete and the notice stream is resumable: `cp/events` replays by `Last-Event-ID` per principal, a replay it cannot serve becomes `streamGap`, and the app answers a gap and every start with a list re-read. Alerts and dots are derived from state, not from transitions: a finish or failure is `lastTurn.completedAt` moving forward, and attention is `awaitingInput` turning true, so a coalesced or replayed notice raises the same alert once.

### A. Status and attention notices for sessions that are not open

The app keeps per-session `wr/events?sessionID=` streams only for open sessions (content). Every other session's status reaches it as a small per-reader notice:

- **Producer.** The server that already sees every status change publishes rows: a machine daemon taps each runtime's `session.status`, `session.idle`, `session.error`, `permission.*` and `question.*` frames (`runtime-session-status.ts`) and posts `HostSessionRow`s (`session-rows-publisher.ts`, 250 ms debounce) to `POST /api/claxedo/host/session-rows`. After the D1 write commits, the hosted ingest sends `session.status.changed { sessionId, workspaceId, status, awaitingInput, backgroundWork, lastTurn, ts }` to the live-sync room of each principal who may read the session (its creator and active share recipients). `eventVisibleTo` and `liveSyncEvent` admit it for those principals only; `event-retention.ts` keeps the latest per session.
- **Cloud sandboxes.** A cloud runtime publishes no rows today, so its sessions have no hosted status at all. The cloud runtime gains the same row publisher (the tap already exists in the daemon), so cloud sessions get both the snapshot and the notice.
- **Consumers.** The web, signed, already reads the hosted `cp/events`. A signed desktop subscribes to the account's `cp/events` too (the `controlPlane.events` hosted operation has no caller today). Local folders keep the daemon's host aggregate `wr/events`.
- **App.** `wire/frames.ts` maps `session.status.changed` to the existing `statusChanged` plus the row's `lastTurn`; the list store applies it under its reconcile rules (newer wins). `AttentionAlerts` raises the finished sound and notification when a row's `lastTurn.completedAt` moves forward, the error alert when that turn failed, and the permission alert when `awaitingInput` turns true, for any row in the list, open or not.

### B. `lastTurn` on the list item

- **Daemon:** two scalar columns on `claxedo_session_meta`, `last_turn_status` and `last_turn_completed_at`, written from the runtime's `onTurnOutcome` hook (`workspace-runtime/src/workspace/runtime.ts`, wired in `start-local-server.ts`) as the authoritative producer. They are read by primary key with the row; no index and no JSON-blob projection. New claxedo-migration adding the columns; no backfill (a row with no column value shows no dot until its next turn).
- **Hosted:** the same two columns on D1 `sessions` in a regenerated `0001_baseline.sql` (`bun run d1:baseline:generate`), carried by `HostSessionRow` from the daemon's publisher and selected by `readD1SessionPage`.
- **Frames:** the runtime adds `lastTurn` to the turn-end `session.idle` / `session.error` frame it already sends, so the live row and the snapshot agree.
- **App:** `SessionRow.lastTurn` comes from list items as well as session reads; `src/session/README.md` rule 2 is rewritten.

### C. `seenAt` per reader

- **Daemon (unsigned, single user):** table `claxedo_session_reads(user_id, session_ref, seen_at)` beside `meta.sql.ts`, with `user_id = "local"`, left-joined by `listSessionNavigationMetas`. Route `POST /api/claxedo/session/:id/seen { completedAt }` stores `max(seen_at, completedAt)` and publishes `session.seen` on `controlBus` (the unsigned subscriber sees every notice).
- **Hosted:** D1 table `session_reads(user_id, session_id, seen_at)` in the baseline, primary key `(user_id, session_id)`, joined in `readD1SessionPage` on the principal. Route `POST /api/control/sessions/:sessionId/seen`, declared once as a hosted operation in `account-contract/src/hosted-operations.ts` (renderer exposure, `retry: "never"`), authorized as a session read. It publishes `session.seen { ownerUserId, sessionId, workspaceId, seenAt, ts }` through `nudgeLiveSyncRoom`; `eventVisibleTo` gains `case "session.seen": return event.ownerUserId === principal.subject`; `liveSyncEvent` admits it; `event-retention.ts` keeps it in the terminal reserve.
- **App:** `wire/frames.ts` maps `session.seen` to a `sessionSeen` event that sets `row.seenAt`. Opening a session, and a turn ending while it is shown, send one seen write through `src/server/` carrying that turn's `completedAt`; the store holds it as a pending entry confirmed by the server, per the app's optimistic rule. `SessionStores.unseenOutcomes` and the marks in `AttentionAlerts` are deleted; `AttentionAlerts` keeps sounds and system notifications only. `navigationStatus` derives from the row.

### Owner decisions (accepted 2026-10-02)

1. **A signed desktop's local-folder sessions.** The desktop lists them from the daemon (unsigned path, user `"local"`), while the web lists the same machine-placed sessions from D1. Decided: when signed, the seen write and `seenAt` go to the hosted store for every session the hosted registry knows, so the dot agrees across devices; the daemon store serves unsigned mode only. This also needs the signed desktop to subscribe to the account's `cp/events` (the `controlPlane.events` operation has no caller today).
2. **Cloud row publisher ordering.** Part A's cloud producer is the runtime publishing rows the way a daemon does. Decided: land it with A, not after, since without it a cloud session has neither a snapshot status nor a notice.
3. **Alert on reconnect.** A turn that ended while the app was disconnected is recovered by the re-read with its dot. Decided: it plays no sound and raises no system notification, as today, since the reader was not there for it; only a notice that arrives live alerts.

## Phases

- [ ] **A. Status and attention notices.** `session.status.changed` from the hosted ingest to each reader; cloud runtime row publisher; signed desktop subscribes to the account's `cp/events`; alerts derived from `lastTurn` and `awaitingInput`.
  - Done when: an unopened machine session and an unopened cloud session each show working, waiting on you, finished and failed live in the rail, with the sound and system notification, and with no transcript stream open for them; a turn shorter than the publisher's debounce still raises exactly one finished alert; a dropped `cp/events` connection that misses a turn end recovers it from the re-read with the dot set; a share recipient receives the notice and an unrelated user of the same org does not (visibility tests); idle CPU and the benchmark verdict lose no row against the build before.
  - Progress:
- [ ] **B. `lastTurn` on list items.** Daemon columns + migration, D1 baseline columns, `HostSessionRow`, turn-end frames, app mapping and README rule 2.
  - Done when: a list read returns `lastTurn` for a session whose last turn completed, failed or was cancelled, read by primary key (show the query plan); a turn-end frame carries the same value; server unit tests cover each status.
  - Progress:
- [ ] **C. `seenAt` per reader.** Stores, routes, hosted operation, `session.seen` notice and visibility, app write and mapping, deletion of `unseenOutcomes`.
  - Done when: a finished dot survives a reload and a daemon restart (unsigned), and clears on open and stays cleared after a reload; for two signed users on one shared session, one user's open clears only their dot; a second device of the same user clears within one notice; `eventVisibleTo` and `liveSyncEvent` tests prove another principal never receives `session.seen`.
  - Progress:
- [ ] **D. Records.** `src/server/README.md`, `src/session/README.md`, `src/notifications/README.md`, `src/rail/README.md`, the server-core event docblock in `bus.ts`, and this plan's removal once shipped.
  - Progress:

## Definition of done

- [ ] No in-memory unseen mark remains in the app; `git grep -n unseenOutcomes` finds nothing.
- [ ] Unseen is derived from `lastTurn` and `seenAt` on the row; nothing stores "unseen".
- [ ] Every flow above has a recorded red run (the feature switched off) and passes 20 runs in a row at desktop width and in `phone` where the rail is involved.
- [ ] `bun run check`, `bun run typecheck`, `bun run test` in `packages/claxedo-app`; the touched server packages' tests and typechecks; `bun run test:architecture-ratchets`; `bun run --cwd packages/claxedo-desktop verify:closure` when desktop imports change.
- [ ] The control-plane schema check passes with one `0001_baseline.sql`; no row-rewriting migration.
- [ ] Commands and outcomes are recorded in this plan's Progress lines.

## Execution

Parallel lanes with disjoint ownership, then one adversarial review of each lane's diff:

- Lane A: the hosted ingest's notice, `event-visibility.ts`, `live-sync-room.cf.ts`, `event-retention.ts`, the cloud runtime's row publisher, the signed desktop's `cp/events` subscription, and the app's `frames.ts` mapping and `AttentionAlerts` derivation.
- Lane B: `claxedo-server-core` session meta + migration, `claxedo-local-server` turn-outcome wiring and list page, `claxedo-server` D1 baseline and `HostSessionRow`, runtime turn-end frames.
- Lane C (after B's list-item shape lands): seen stores, routes, hosted operation, event visibility, live-sync room, then the app's write, mapping and deletion of `unseenOutcomes`.
