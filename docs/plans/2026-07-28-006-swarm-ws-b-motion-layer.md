# WS-B — Motion layer: cursors, doorbells, dirty-set recovery, identity/timeouts

**Parent:** `2026-07-28-004` · implements M1–M4 of `2026-07-28-003` §3. Depends on WS-A (renames). Convex-heavy; parallel-safe with WS-C/D except the two shared files flagged inline.
**Prime directive:** these are coordination/cost fixes — **every task ships a positive-control test** (prove the failure without the fix). Use `convex-test` (already a devDependency, currently unused — `claxedo-server/package.json:118`) where index/transaction realism matters; the in-repo `ConvexHarness` fake does not enforce indexes.

## Non-goals
- No behavior change to command semantics, approval, or execution — this WS only changes *how change propagates and recovers*.
- Do not touch the Bun relay or live-sync room internals beyond the doorbell payload.
- Single-box SQLite behavior: identical results; its single-writer implementation may keep simpler internals behind the same contract.

## B1. Kill the per-owner cursor hot row (M1)

**Grounding.** `workgraph_change_cursors` is one row per (org, owner) (`convex/schema.ts:1097-1102`), patched by `allocateCursor` (`convex/workgraphCommands.ts:2650-2671`) on **every** command (call sites `:194, :2712, :2762`) — the per-owner OCC serialization point. Per-stream sequences already exist and are **already allocated on the same main path** (`allocateSequence` `:2673-2695`, called at `:196, :2713, :2763`; `OWNER_EVENT_SEQUENCE` sentinel for owner-scope events). Readers of the owner scalar (the full list — every one must be updated): snapshot cursor derivation `workgraphChanges.ts:478-483`; resume invalidation `:487-494`; `all`-scope feed `by_tenant_cursor` `:596-605`; wire formats `contracts/change-cursor.ts:20-61` (`wgc1`, single integer) and `snapshot-cursor.ts:53-56`; `workgraph_operation_results.change_cursor` scalar (`workgraphCommands.ts:2890`); archive invariant `archive.ts:1501-1506` + restore `workgraphArchive.ts:289-295`. SQLite twin: `wg_v2_change_cursors` (`sqlite/schema.ts:529-538`), `store.ts:6432-6451`, call sites `store.ts:429, :5755, :6231`, `activity-store.ts:538-549`.

**Design (decided): stream-sequence + creation-time watermark.**
- `workgraph_changes` rows already carry `(stream_id, cursor)`; `cursor` becomes the **per-stream sequence** (from `allocateSequence` — no new allocation). Owner-scope ordering moves to Convex `_creationTime`.
- **Delete `workgraph_change_cursors`** (table + `allocateCursor` + all call sites). Delete-don't-deprecate.
- Wire format `wgc2:org:owner:scope:streamOrStar:watermarkMs` — `position` is a millisecond watermark for `all` scope, the stream sequence for stream scope. `wgsp2` embeds it. Bump both format constants; parsers reject `wgc1` (zero users).
- `all`-scope feed: query `by_tenant` range on `_creationTime > watermark − OVERLAP_MS` (constant `CHANGE_FEED_OVERLAP_MS = 5_000`), **dedupe by change id client-side of the query fn**, return new watermark = max `_creationTime` seen. Overlap absorbs commit-time skew between concurrent transactions.
- Snapshot cursor: watermark at snapshot read time; resume invalidation compares `_creationTime > watermark` (index `by_tenant` + `_creationTime` is implicit in Convex).
- `operation_results.change_cursor` → store the stream sequence (replay return unchanged in shape).
- Archive invariant: assert per-stream `next_sequence === max(cursor)+1` for each archived stream (replaces the owner-scalar check); restore re-seeds `workgraph_stream_sequences` only.
- SQLite: single-writer, no contention — keep a monotonic per-owner counter internally if simplest, but **emit the same `wgc2` wire format** (watermark = its own clock/counter). The store contract is the boundary; conformance (below) is the referee.

**Positive controls (required):**
1. convex-test: K streams × N concurrent `applyWorkGraphCommand` under one owner — with the fix, zero writes to any shared per-owner row (assert table absent) and all commands commit without conflict-retry storms; feed replay returns every change exactly once after id-dedupe.
2. Conformance: `ordered change cursors`, `snapshot pagination + resume`, `snapshot/changes exactly-once convergence` invariants (conformance scope list, v7) updated to the new format and green on **both** adapters.
3. Failure-first: on current code, demonstrate the OCC hot row (two concurrent commands patch the same `_id`).

## B2. Doorbell carries the cursor; clients skip redundant fetches (M2)

**Grounding.** Event is a bare doorbell: `claxedo-app/src/features/workgraph/workgraph-changed-event.ts:13-21` `{type, ownerUserId, ts}`; server mirror `claxedo-server/src/bus.ts:79`; the two are pinned by `doorbell-event-contract.test.ts:35-50`. App handler discards the payload (`sync-lifecycle.ts:124`). Producers: `workgraph-host/hosted.ts:203-231`, `hosted-app.ts:316-325`, `hosted-run-operation.ts:139` (post-WS-A name), `hosted-app.ts:522`.

**Tasks:**
1. Add optional `cursor?: string` (a `wgc2` value) + `streamId?: string` to the event type in BOTH files + update the contract test. Producers thread the post-command watermark (the command result already returns it — `saveOperation`).
2. `sync-lifecycle.ts`: store the last-applied snapshot watermark; on doorbell, if `cursor <= lastApplied`, skip `scheduleReload()` (keep the 100ms debounce for the fetch path). Add `sync-lifecycle.test.ts` — it does not exist today (e2e agent: zero tests on this file).
3. Delivery floor: on the reload-triggering edges (`sync-lifecycle.ts:130-139`) nothing changes; ADD a slow poll (`WORKGRAPH_POLL_FALLBACK_MS = 60_000`, active only while the page is visible and a stream is live) so a missed-while-connected doorbell has a bounded staleness horizon.
4. Deletion paging: `deleteStreamGraph`'s 9 unbounded `streamRows().collect()`s (`workgraphCommands.ts:1784-1797`) become paged loops using the boundedness-invariant pattern (`workgraphChanges.ts:542-553`, named constants + `.take()`), re-armed via the existing outbox job until drained. (Correction from grounding: these collects are the *deletion* path, not the snapshot path — snapshot/changes already largely follow the invariant.)

**Positive controls:** doorbell with stale cursor → zero fetches (unit); missed doorbell → poll recovers within 60s (fake timers); stream with > page-size rows deletes fully across multiple job runs (convex-test).

## B3. Dirty-set recovery; the sweep never enumerates tenants (M3)

**Grounding.** `listWorkerTenants` = first 500 `org_memberships`, no dirty filter (`convex/workgraphRuntime.ts:32-40`); sole caller `hosted-runtime.ts:208-211`. A *derived* staleness signal already exists: `listStaleTenants` (`workgraphRuntime.ts:42-79`) over `workgraph_outbox` pending/expired-claim rows. The `* * * * *` settler branch (`worker.ts:337-350`) is live code with no registered trigger (`wrangler.toml` has only `*/15`). Wakes substrate for lanes: `convex/wakes.ts` `claimDueWakes:250` (note: `.collect()`s all due — bound it while here), `reclaimFiringWakes:372`.

**Tasks:**
1. New table `workgraph_dirty_tenants` `{organization_id, owner_user_id, dirty_at, drained_at?}` unique per tenant, index `by_dirty` `[drained_at, dirty_at]`. Upsert `dirty_at = now` inside `applyWorkGraphCommand` (`:194` area — same transaction; per-tenant row, contention only within an owner's own commands, which B1 already made stream-parallel; a point-patch on this row is acceptable because it is blind-write, not read-modify-conflict — verify with convex-test that two concurrent commands both succeed).
2. Rewrite the 15-min sweep work-set: `listWorkerTenants` → `listDirtyTenants({limit, before})` draining `by_dirty` (undrained first, oldest `dirty_at` first); mark `drained_at` after a clean reconcile of that tenant. Keep `listStaleTenants` (outbox-derived) as a second source, unioned. Delete the 500-row membership scan.
3. Budget the tick: `SWEEP_SUBREQUEST_BUDGET = 800` — the reconcile loop counts its Convex/relay calls and stops cleanly, leaving the remainder dirty (natural cursor). Log dropped-count (no silent caps).
4. Cron truth: register `"* * * * *"` in `wrangler.toml` (prod + staging — triggers are not environment-inherited) so the existing stale-tenant settler branch actually runs, gated to cheap-when-empty (`listStaleTenants` short-circuit exists). Add the drift-guard test: parse `wrangler.toml`, assert every registered cron string matches a live branch in `scheduled()` and vice versa (kills the dead-branch class; supersedes chip task_162cc1cb).
5. Bound `claimDueWakes`' due-scan with `.take(limit * 4)` + the one-firing-per-lane check (currently `.collect()`).

**Positive controls:** fixture with 1,000 tenants of which 3 dirty — sweep touches exactly 3 (convex-test call-count assertion); budget exhaustion mid-drain leaves remainder dirty and next tick finishes; on current code, show the 500-row scan touches all.

## B4. Identity cache + timeouts + honest failure statuses (M4)

**Grounding.** `ownerContext` runs `orgs.resolveForMe` + `users.me` — both `authedMutation`s with `upsertUser` side effects, no query variants (`convex/users.ts:4`, `convex/orgs.ts:78-97`; adapter `convex-authority-identity.ts:18-36`; CLI auth already short-circuits). Cache key material: `auth.token` / `(subject, orgId)`. Per-call `ConvexHttpClient` construction sites: `convex-authority-executor.ts:58-59` (all identity methods), `convex-usage-ledger.ts:31`, `org-membership.ts:53`, `billing-store.ts:118,135`, `wake-settlement-dispatcher.ts:41`. Timeouts exist only on PostHog/catalog/doc-relay.

**Tasks:**
1. Per-isolate TTL cache (60s) for `{organizationId, ownerUserId}` keyed `sha256(auth.token)`, **cache-on-success only** (misses must still run the upsert path for genuinely-new users); evict on any 401/403 from downstream. Location: wrap inside `ownerContext` (`hosted.ts:254-278`) so both resolvers are covered in one place.
2. `withTimeout(promise, ms, code)` helper in `control-plane/`; wrap every `ConvexHttpClient` call site above (default 5s reads / 10s mutations, env-overridable) mapping timeout → `ControlPlaneAuthError(503, "workspace_authority_unavailable")` where auth-shaped, else a typed 503. Note: this bounds *waiting*, not the underlying fetch — acceptable; document it in the helper.
3. Chip task_b52a1702 lands here or before: the workgraph router must propagate explicit-status errors instead of collapsing to 401 (`packages/workgraph/src/http/router.ts:96-99`). If the chip already merged, verify; else implement per the chip prompt.
4. Leave per-call client construction as-is EXCEPT `convex-authority-executor.ts` — module-level `Map<url, ConvexHttpClient>` is unsafe with `setAuth` (shared mutable auth); instead keep per-call construction and note why in a comment (constraint the code can't show).

**Positive controls:** authority stub that hangs → request fails 503 within the timeout (not 30s+); repeated authenticated calls hit Convex identity once per TTL window (spy count); Convex-down → workgraph route returns 503 `workspace_authority_unavailable`, missing bearer still 401.

## Leave it better (bounded, in touched files only)
- `workgraphRuntime.ts:42-79` comment says the outbox backstop is "temporary until staging proves the fast lane" — update to describe the dirty-set design (v0 authorship: describe what IS).
- Fold `activity-store.ts:538-549`'s duplicate SQLite cursor logic into the store helper it mirrors.
- Delete `convex-test` from devDependencies **or** start using it (this WS uses it — keep, and remove the vestigial note).

## DoD
All positive controls above green; conformance v7→v8 bump with the new cursor invariants on both adapters; `rg workgraph_change_cursors` returns zero hits; sweep fixture proves O(dirty) not O(tenants); wrangler cron drift-guard test in CI; chips task_162cc1cb + task_b52a1702 closeable (their DoDs subsumed — dismiss or complete them referencing this WS).
