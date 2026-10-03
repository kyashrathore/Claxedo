# Activity sidebar, seen state and settle: rebuild plan

Owner: the orchestrating session. Base: `dev` 60fe7c6385 (f69c8ec42d reverted, review fixes landed). This plan extends `docs/plans/2026-10-02-001-feat-session-seen-state-plan.md` (the owner accepted it; its "On open" seen rule was re-confirmed on 2026-10-03) with the Activity view, Settle and agent session delete. f69c8ec42d is the cautionary reference: read its diff for UI details worth keeping, never for architecture.

## Owner rulings (binding)

1. **Seen** (2026-10-02 plan; seen on open re-confirmed 2026-10-03).
   - Seen is per (reader, session) on the server.
   - Unsigned local: one user (`LOCAL_USER_ID = "local"`, never a new identity), persisted in the daemon.
   - Signed: the hosted store holds it for every session the hosted registry knows; the daemon store serves unsigned mode only.
   - Unseen = `lastTurn.completedAt > (seenAt ?? 0)`, and the session is not working, waiting or running background work.
   - A seen write happens when the session is opened, or when a turn ends while it is shown. One write, carrying that turn's `completedAt`.
2. **No missed status/attention events, and no content streams for unopened sessions.**
   - Use a snapshot plus a resumable `cp/events` notice. A gap means a list re-read.
   - Alerts are derived from state: `lastTurn.completedAt` advancing, or `awaitingInput` turning true.
   - A turn that ended while the app was disconnected shows its dot after the re-read, with no sound.
3. **List order is flat** `last_human_turn_at DESC NULLS LAST, created_at DESC`.
   - Only the reader's own send moves a row; that applies in Activity too, including a pending send.
   - No bands.
4. **Access.** Only session shares cross people. Org/team roles grant nothing on machines. Notice recipients are the session owner plus active share recipients, computed from those rows, never by scanning actors.
5. **Settle.**
   - Per-reader `settled_at`, with a Settle button on rows in both Projects and Activity.
   - Settled rows are hidden in both views by default.
   - The sidebar filter menu has "Show settled", which reveals them in both views; there "Return to active" clears `settled_at`.
   - A session counts as settled while `settled_at >= max(last_human_turn_at, lastTurn.completedAt)`, so a new send or turn result un-settles it with no write.
   - Settle is a pure per-reader write; it never needs the owner's machine to be online.
   - The settled filter runs in the list query, before pagination. Toggling "Show settled" re-reads.
6. **Activity view.** One flat list across all projects/placements the reader can read, ordered as in rule 3, holding only "active" sessions: not settled (unless Show settled is on), and not archived. Keep:
   - the Working / Needs-you filter cycle;
   - the "Hide working statuses" preference (hides animated working marks until row hover/focus, with no geometry change);
   - the title marquee.
   - "Needs you" means `awaitingInput` true, or an unseen failed/finished result. It does NOT mean "not working".
7. **Archive/Delete stay removed from the row menu.** Deleting is an agent MCP `session_delete` confined to the credential's own workspace, gated by the existing tool-group consent. There is no account-wide cleanup, no capability grants, no desktop grant sync and no cleanup inventory.
8. **Hot paths stay lean.**
   - No full-table scans: every list/notice/seen query is an indexed range or a primary-key read, proven with EXPLAIN QUERY PLAN in a test or the PR notes.
   - No JSON-blob predicates in WHERE; scalar columns only.
   - No per-event list re-reads in the app.
9. **No backward compatibility, no data migrations.**
   - Edit the D1 `0001_baseline.sql` in place.
   - Daemon: one new claxedo-migration adding columns/tables, with no backfill.
   - session-core store: edit the schema in place; old stores are refused.

## Lanes (each lands as one or a few commits on `dev`, after one adversarial review)

### B: `lastTurn` on list items (first; others build on its row shape)
- Daemon: scalar `last_turn_status`, `last_turn_completed_at` on `claxedo_session_meta`, written only from the runtime's `onTurnOutcome` hook (the authoritative producer), and read with the row.
- D1: the same two columns on `sessions` in the baseline, carried by `HostSessionRow` from the daemon publisher and selected by the list read.
- Turn-end `session.idle`/`session.error` frames carry `lastTurn`.
- App: `SessionRow.lastTurn` comes from list items; update the `src/session/README.md` reconcile rule.
- Tests: each status (completed/failed/cancelled), frame vs snapshot agreement, and the query plan.
- Progress: implemented on `rebuild/b-lastturn`; review findings fixed, awaiting re-review.
  - The turn-end frame has one producer: `RuntimeStore.finishTurn` returns `session.idle`/`session.error` with `lastTurn { status, completedAt }` read from the outcome it journals as `turn.finish`. The projection no longer emits an idle for a harness `finish`/`cancelled` chunk, recovery's separate global idle announcement is gone, and a seeded child's settle publishes only `finishTurn`'s events (no second terminal through the parent's router). `onTurnOutcome` fires only for a turn the store recorded and names its workspace.
  - Daemon: `claxedo_session_meta.last_turn_status`/`last_turn_completed_at` (migration `20261003000100_session_meta_last_turn`, no backfill), written by `recordSessionLastTurn` on the local server's event tail behind the `session.updated` projection that creates a child's row, read with the row. D1: the same columns on `sessions` in `0001_baseline.sql`, carried by `HostSessionRow.lastTurn`, written by the ingest and selected by `readD1SessionPage`. App: `SessionRow.lastTurn` from list items and turn-end frames, merged by `laterTurn` (README rule 2).
  - One tie rule: only a later `completedAt` replaces the held last turn (daemon, D1, app); at an equal one the app only takes the session read's full outcome of the same turn.
  - Harness wire corpus re-recorded for the `lastTurn` frames (`bun run --cwd packages/harness corpus <flow> record`).
  - Query plans (recorded by tests): daemon row read `SEARCH claxedo_session_meta USING INDEX sqlite_autoindex_claxedo_session_meta_1 (session_ref=?)`; daemon write `SEARCH claxedo_session_meta USING INDEX claxedo_session_meta_session_idx (session_id=?)`; D1 list read `SEARCH s USING INDEX sessions_by_project_human_turn (project_id=? AND deleted_at=? AND archived_at=?)`, no `SCAN s`.

### E: agent delete + kept fixes (parallel with B)
- `session_delete` MCP tool for the `runtime` audience:
  - confined to the credential's own workspace;
  - gated by the existing tool-group consent and the existing `ownerDriven` check;
  - refuses a working/awaiting session in the tree;
  - one delete path in `session-core/src/routes/session-delete.ts`: hold idle on the root + its sorted descendants, delete leaf-first, and on a hook failure abort and report the ids deleted.
- Re-implement three good parts of f69c8ec42d as separate commits:
  - per-user/org revocation in `claxedo-server/src/tasks/grant-withdrawal.ts`;
  - the `source-closure.ts` scanner fix (product-boundary ratchet);
  - removing team-recipient expansion from session share fan-out (access ruling).
  - Each part gets its own test, red without it.

### A: status notices (after B)
- Hosted ingest of host session rows sends `session.status.changed { sessionId, workspaceId, status, awaitingInput, backgroundWork, lastTurn, ts }` after the D1 write commits:
  - only for rows whose status/awaitingInput/backgroundWork/lastTurn actually changed (use `RETURNING` or compare);
  - to the owner + active share recipients, read from `session_share_grants` by session id;
  - nudges in parallel after commit; a failed nudge is logged and never turns the committed write into a 500.
- `eventVisibleTo` / `liveSyncEvent` admit it per recipient. Retention: keep the latest per session, outside the 64-entry terminal ring, so it can't evict doorbells. Delivery is never awaited per frame against D1.
- Cloud runtime: reuse the daemon's `session-rows-publisher` by moving it to a shared owner with injected credential/URL ports. The cloud side is a thin adapter; do not write a second publisher. Pass lifetime is bound to the lease.
- A signed desktop subscribes to the account's `cp/events` (the `controlPlane.events` hosted operation).
- Local: the daemon's runtime-status tracker publishes only on a real change (restore the unchanged → return filter). No self-feeding refresh.
- App: `wire/frames.ts` maps the notice to `statusChanged` + `lastTurn`. `AttentionAlerts` derives alerts from `lastTurn.completedAt` advancing / `awaitingInput` rising; replays never alert.
- Progress: implemented on `rebuild/a-notices` and landed; the cloud runtime publisher is lane A2.
  - Review fixes: notices name readers by canonical user id under the session read rule (`sessionReaderSql`); the pre-read is the batch's first statement; each room gets one batched nudge under `waitUntil`; the desktop account stream errors its body on abort and closes a stream aborted while opening; a failed status with no recorded turn alerts once, and a question waits on the reader as a permission does.
  - Ingest: `publishD1HostSessionRows` returns each update's row (`returning`) and compares it with the row read at the start of the same batch; a change to status, wait, background work (three scalar columns on `sessions` in `0001_baseline.sql`) or last turn yields one notice per reader. Readers are the workspace owner and direct people shares, active and in the session's org (`d1/session-status-notices.ts`). The route nudges `org:<session org>` after commit, all at once; a failed nudge is logged and the publish answers 200.
  - Room: admits the notice for its named reader (`live-sync-admission.ts`), keeps it out of the terminal reserve, replays only the latest per reader and session, and marks a replayed notice `replayed`. A released principal whose frames the room ring evicted now gets a replay gap.
  - Daemon: the tracker follows `session.background-work` and reports only a change of kind, wait or background work; fifty streamed parts publish nothing.
  - App: a notice for a session whose own stream is open is dropped; alerts are derived in `session/store/attention.ts` against the row held before the event; a signed desktop reads its account's `cp/events` through `controlPlane.events` (`server/account-events.ts`).
  - Query plans (recorded by test): readers `SEARCH s USING INDEX sqlite_autoindex_sessions_1 (session_id=?)`, `SEARCH w USING INDEX sqlite_autoindex_workspaces_1 (workspace_id=?)`, `SEARCH g USING INDEX session_share_grants_active_user (session_id=? AND target_user_id>?)`, `SEARCH u USING INDEX sqlite_autoindex_users_1 (user_id=?)`, `SEARCH member_org USING INDEX sqlite_autoindex_orgs_1 (org_id=?)`, `SEARCH member_row USING COVERING INDEX org_memberships_by_user`, and the read rule's subqueries by their keys; the pre-read and the update by primary key. No `SCAN` of a table.
  - Cloud runtime (lane A2, `rebuild/a2-cloud-rows`): the publisher, the status tracker and the runtime activity reader moved to `claxedo-server-core/src/session/` with injected source, credential and URL ports; the daemon composes them unchanged. A relay-exposed cloud runtime composes them in `hosts/workspace-runtime/cloud-session-rows.ts` over its own store (`bindSessionReads`; whole-store reads `listEverySession`/`listEveryPermission`/`listEveryQuestion`, so a worktree session is included) and presentation events, and flushes before its store closes (`beforeStoreClose`). Its credential is a sandbox pass under audience `workspace-runtime-session-rows` (`session/session-rows-pass.ts`) naming one workspace, its owner and a `lease_epoch`. The control plane delivers it after each config push, over the relay as its service actor, unless the runtime holds a current one not yet due; one pass is live per workspace (each mint revokes the earlier ones). The ingest admits it only while the lease row serves that epoch and its user still owns the workspace by `resolveWorkspaceOwner`; renewal is refused before half-life. The cloud ingest goes through lane A's transactional pre-read and per-room batched nudges. The runtime's renewal loop is shared with the Tasks grant (`half-life-renewal.ts`). Query plans (recorded by test): `SEARCH sandbox_leases USING INDEX sqlite_autoindex_sandbox_leases_1 (workspace_id=?)`, `SEARCH owner USING INDEX actors_one_human_per_user (user_id=?)`, `SEARCH w USING INDEX workspaces_by_owner (owner_user_id=? AND deleted_at=? AND workspace_id=?)`.

### C: seen + settle (after B)
- Daemon (unsigned):
  - `claxedo_session_reads(user_id, session_ref, seen_at, settled_at)`, left-joined by the list query;
  - `POST /api/claxedo/session/:id/seen { completedAt }` stores `max`;
  - `POST /api/claxedo/session/:id/settle { settled: boolean }`;
  - both publish `session.reader.changed` on controlBus.
- Hosted:
  - D1 `session_reads(user_id, session_id, seen_at, settled_at)`, PK `(user_id, session_id)`, joined on the principal;
  - routes `POST /api/control/sessions/:id/seen` and `/settle`, declared as hosted operations in `account-contract`, authorized as a session read;
  - the notice `session.reader.changed { ownerUserId, sessionId, workspaceId, seenAt, settledAt }` goes only to the reader's room (`eventVisibleTo`: `ownerUserId === principal.subject`). No recipient query.
- The list query takes `settled = active | all` and filters before pagination.
- App:
  - seen write on open, or when a turn ends while shown; Settle/Return writes;
  - the returned state is applied (no re-read);
  - the optimistic pending entry is confirmed by the server;
  - delete `SessionStores.unseenOutcomes`;
  - `navigationStatus` derives from the row and keeps the background/interrupted/pending marks.
- Progress: implemented on `rebuild/c-seen`, rebased on lane A; review fixes applied, awaiting re-review.
  - Daemon: `claxedo_session_reads` (migration `20261003000200_session_reads`, PK `(user_id, session_ref)` plus a `session_ref` index), written by `session/meta/reads.ts` `writeSessionReader` for `LOCAL_USER_ID`; the routes refuse a signed caller (403). Reader rows are deleted with the session's meta (tree delete and stale sweep) and move with a ref re-key; a reader with rows on both refs keeps the later of each mark.
  - Hosted: `session_reads` in `0001_baseline.sql`; `recordD1SessionReader` authorizes with the list's own read predicate and is the authority port's `recordSessionReader`; routes in `session/routes/session-reader.ts` ring `session.reader.changed` to the reader's room after the write commits (a failed ring is logged). `liveSyncEvent` (`live-sync-admission.ts`) admits the notice, `eventVisibleTo` gives it to its reader only, and a replay keeps the latest per reader and session (`supersededControlPlaneEventKey`); a signed desktop hears it on lane A's account event stream.
  - Clocks: every mark is a runtime timestamp. A settle stores the later of the activity the reader's row showed (`through`) and the store's own record, so a hosted row lagging the machine never loses a settle. A seen mark is capped at the later of the stored last turn end and the server's clock, so a future timestamp cannot hide every later dot while a turn end the store has not recorded yet still counts.
  - One settle rule for both stores (`navigation-order.ts` `unsettledSql`): active while `settled_at IS NULL OR settled_at < max(coalesce(last_human_turn_at, 0), coalesce(last_turn_completed_at, 0))`.
  - Signed desktop: a session's marks live on the account when its workspace is in the account's catalog (`workspaces.accountKnows`) or it is shared with the reader. A paired project's two pages are read with `settled=all`; the merge counts one row per workspace and session id, takes those sessions' marks from the account's copy (none when the account did not answer), and drops what the reader settled before cutting the page, reading on until the page is full or both sources end.
  - App: `SessionPage.readers` → `ListData.readers` (`list/readers.ts`), pending writes confirmed or rolled back (`list/reader-writes.ts`), `unseenOutcome` derived from the row, `view/seen-while-shown.ts` writes once per turn end while shown and retries a refused write once on the next turn end or showing. "Show settled" is a stored preference (`preferences.sidebar.showSettled`) that drives the `settled` param and visibility; `list.settle`, `list.markSeen`, `list.readerOf` and `setSidebar` are the API for lane D, which owns the Settle/Return buttons and the "Show settled" menu item. `SessionStores.unseenOutcomes` and the marks in `AttentionAlerts` are gone.
  - Query plans (recorded by tests): daemon list `SEARCH m USING INDEX claxedo_session_meta_workspace_archive_human_turn_idx (workspace_id=? AND archived_at=?)`, `SEARCH r USING INDEX sqlite_autoindex_claxedo_session_reads_1 (user_id=? AND session_ref=?) LEFT-JOIN`; D1 list `SEARCH s USING INDEX sessions_by_project_human_turn (project_id=? AND deleted_at=? AND archived_at=?)`, `SEARCH r USING INDEX sqlite_autoindex_session_reads_1 (user_id=? AND session_id=?) LEFT-JOIN`; no `SCAN` of `s`, `m` or `r`.

### D: Activity view + rail (after B and C)
- Activity is one more window in the existing `ListState.windows`: key `"activity"`, `scope=all`, `settled` per the preference. It uses the same fetch/reread/held/streamGap paths and `insideWindow(orderKey, tail)` membership. No parallel inventory store.
- Live notices update entries in place. A notice for an unloaded id inside the tail inserts it, using `lastHumanTurnAt` from the notice or one exact row read.
- The hosted `scope=all` query is "workspaces the reader owns ∪ sessions shared to the reader", using indexed columns. Do not COUNT on every page; drop `totalKnown` unless the UI needs it.
- Filter menu:
  - Show settled (the preference drives the `settled` param for every window);
  - Hide working statuses (derived effective filter, no syncing effect);
  - the Working/Needs-you cycle, filtered client-side over the loaded window, or as a server param if that's an indexed column predicate.
- Rows reuse `RailSessionRow`/`NavigationRow` (no duplicated menu/open logic). One `settled`/`canSettle` predicate is owned by session/list.
- Title marquee; per-row cost measured (no always-on observers per row).
- Kit icons go through a `packages/ui/patches/*.patch` (never unpatched edits in `packages/ui/src`), or into the app's own sprite.
- E2E covers behaviour, not CSS values:
  - Activity ordering;
  - settle hides → Show settled reveals → Return restores;
  - Projects settle;
  - filter cycle;
  - hide-working hover reveal;
  - unseen dot cleared on open and kept after reload.
- Progress: implemented on `rebuild/d-activity`; awaiting review.
  - Server: `scope=all` on the shared navigation list. The daemon reads every local workspace's projection through `claxedo_session_meta_archive_human_turn_idx` (migration `20261003000300`, no backfill); the D1 read (`everyReadable`) narrows candidates to the reader's owned workspaces and its active shares, then applies the read rule per row. A `sessionId` narrows any scope to one row, read with no ORDER BY. `session.activity.page` is the account operation for a signed desktop. `totalKnown` is gone (nothing read it).
  - App: `ACTIVITY_WINDOW` in `ListState.windows` (20 rows a page), read on the first read and re-reads once the view has been shown, opened through `loadMore`; a replace re-read drops a row only when every window holding it was read. A turn end for a session the list does not hold, while Show settled is off, reads that one row with `settled=all` and applies the notice's turn (`readTurnEndRow`), so a settled row a new result un-settles returns without a list re-read. Row views carry `settled`; `canSettle` and `matchesActivityFilter` live in `session/list/activity.ts`.
  - Rail: `SessionsHeading` with the options menu (Projects/Activity, Show settled, Hide working statuses as `preferences.sidebar`), the derived All/Working/Needs-you cycle, `ActivityView` reusing `RailSessionRow` and the shared `createRowNavigation`, Settle/Return on rows and in the context menu (Archive/Delete, their dialog, strings and the adapter's `archive`/`remove` removed), CSS-only hidden working marks, a hover-measured title marquee, arrow-key row focus. No new kit icons.
  - Query plans (recorded by tests): daemon all `SEARCH m USING INDEX claxedo_session_meta_archive_human_turn_idx (archived_at=?)` over the live workspaces it covers, exact `SEARCH m USING INDEX claxedo_session_meta_session_idx (session_id=?)`, no SCAN or temp B-tree; D1 all: `SEARCH w USING COVERING INDEX workspaces_by_owner`, then per owned workspace a `CORRELATED LIST SUBQUERY` reading `SEARCH o USING INDEX sessions_by_workspace_human_turn` to its `limit`, and the shares by `session_share_grants_by_user` and the sessions key; the page's `USE TEMP B-TREE FOR ORDER BY` sorts at most (owned workspaces + 1) x `limit` candidates, and the shared arm sorts the reader's active shares that pass the filters (no index orders shares by activity). Exact by `sqlite_autoindex_sessions_1`; no SCAN of `s`, `w`, `g`, `r`, `o`, `h`.
  - Review fixes: a signed desktop's Activity asks the account under the reader's own settled filter, drops the account's sessions from the daemon's page and reads one round (`fill: false`); one `sessionPageScope` mapper for both signed routes; the turn-end row read is once per session and turn end, skips replays, is held during reads and lands only for an admitted root row; showing Activity again reads nothing; Needs you includes interrupted; Settle shows on a coarse pointer beside the age.
  - E2E: flow 49 (web and phone; the filter and hover case at desktop width), flows 10 and 33 updated.
  - Found, not fixed here: in unsigned local mode the runtime records no human turn, and a send's pending stamp outlives the turn (flow 49 sees the sent row stay on top while the server lists it last), in Projects as in Activity; flow 10's "background turn" case fails on dev's app too.

## Definition of done
- No `unseenOutcomes`; unseen is derived from `lastTurn` and `seenAt`.
- Every query on these paths is indexed (plans recorded).
- Each lane has a red-without-fix test and one adversarial review.
- `bun run check`/`typecheck`/`test` in claxedo-app; touched packages' tests and typechecks; `bun run test:architecture-ratchets`; `verify:closure` when desktop imports change; D1 baseline check.
- Production LOC target: about 1,300-1,800 total across lanes (f69c8ec42d was +8,912). Any lane over its estimate by >30% justifies it in its report.
