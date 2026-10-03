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
- Progress: implemented on `rebuild/a-notices` except the cloud runtime publisher; awaiting review.
  - Review fixes: notices name readers by canonical user id under the session read rule (`sessionReaderSql`); the pre-read is the batch's first statement; each room gets one batched nudge under `waitUntil`; the desktop account stream errors its body on abort and closes a stream aborted while opening; a failed status with no recorded turn alerts once, and a question waits on the reader as a permission does.
  - Ingest: `publishD1HostSessionRows` returns each update's row (`returning`) and compares it with the row read at the start of the same batch; a change to status, wait, background work (three scalar columns on `sessions` in `0001_baseline.sql`) or last turn yields one notice per reader. Readers are the workspace owner and direct people shares, active and in the session's org (`d1/session-status-notices.ts`). The route nudges `org:<session org>` after commit, all at once; a failed nudge is logged and the publish answers 200.
  - Room: admits the notice for its named reader (`live-sync-admission.ts`), keeps it out of the terminal reserve, replays only the latest per reader and session, and marks a replayed notice `replayed`. A released principal whose frames the room ring evicted now gets a replay gap.
  - Daemon: the tracker follows `session.background-work` and reports only a change of kind, wait or background work; fifty streamed parts publish nothing.
  - App: a notice for a session whose own stream is open is dropped; alerts are derived in `session/store/attention.ts` against the row held before the event; a signed desktop reads its account's `cp/events` through `controlPlane.events` (`server/account-events.ts`).
  - Query plans (recorded by test): readers `SEARCH s USING INDEX sqlite_autoindex_sessions_1 (session_id=?)`, `SEARCH w USING INDEX sqlite_autoindex_workspaces_1 (workspace_id=?)`, `SEARCH g USING INDEX session_share_grants_active_user (session_id=? AND target_user_id>?)`, `SEARCH u USING INDEX sqlite_autoindex_users_1 (user_id=?)`, `SEARCH member_org USING INDEX sqlite_autoindex_orgs_1 (org_id=?)`, `SEARCH member_row USING COVERING INDEX org_memberships_by_user`, and the read rule's subqueries by their keys; the pre-read and the update by primary key. No `SCAN` of a table.
  - Open: the cloud runtime publishing rows. A sandbox runtime holds no standing control-plane credential (the owner grant exists only in the Agent Plugins build with subagents on), its lease epoch is not known when its env is composed (`SandboxManagerInput.env` is fixed before `ensure` picks the epoch), it cannot read its own status routes in process, and the ingest admits rows only for a machine's served workspaces. It needs its own lane: a sandbox-manager hook that writes per-epoch env, a credential stored against the lease row so it dies with the epoch, a cloud admission in the ingest, and the publisher and tracker moved to a shared owner with injected ports.

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

## Definition of done
- No `unseenOutcomes`; unseen is derived from `lastTurn` and `seenAt`.
- Every query on these paths is indexed (plans recorded).
- Each lane has a red-without-fix test and one adversarial review.
- `bun run check`/`typecheck`/`test` in claxedo-app; touched packages' tests and typechecks; `bun run test:architecture-ratchets` (only the known `dialin-agent.bundle.cjs` failure); `verify:closure` when desktop imports change; D1 baseline check.
- Production LOC target: about 1,300-1,800 total across lanes (f69c8ec42d was +8,912). Any lane over its estimate by >30% justifies it in its report.
