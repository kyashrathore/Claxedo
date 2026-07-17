---
title: "Wakes v2 — Fix the Wakes Package and Build WorkGraph Settlement On It"
type: feat
date: 2026-07-17
status: landed
progress: >
  U0-U9 complete 2026-07-17. Staging settles through wakes (release run
  29559022315 green with the latency budgets: placement <10s, deletion <20s,
  browser gate 30s). CLAXEDO_WAKES_SETTLEMENT=1 on staging only; production
  stays on WorkGraphSettler pending promotion. Follow-ups still open:
  in-transaction wake creation in workgraphCommands (createWakeInTx is ready),
  retire WorkGraphSettler, distinct wake telemetry tag, recaps onto at-wakes,
  live local check of the agent wake tools.
execution: code
builds_on: docs/plans/2026-07-17-001-feat-workgraph-event-driven-settlement-plan.md
inputs:
  - docs/plans/2026-07-17-001-feat-workgraph-event-driven-settlement-plan.md
  - docs/plans/2026-07-07-006-feat-wakes.md
  - docs/plans/2026-07-16-003-workgraph-staging-debug-handoff.md
  - docs/plans/2026-07-13-001-goal-execute-workgraph-end-to-end.md
---

# Wakes v2 — Fix the Wakes Package and Build WorkGraph Settlement On It

## Owner decision (2026-07-17)

Plan 001 (the standalone settlement dispatcher) is **implemented and
shipping**: tenant-scoped reconcile, the `SettlementDispatcher` port, nudges
on commands, the `WORKGRAPH_SETTLER` Durable Object fast lane, the
stale-tenant backstop, and the latency budgets (commits `aa89411dbe` through
`757fd838cd`). It fixes the measured latency problem now.

This plan is the follow-on the owner asked for: **fix `@claxedo/wakes`** so it
becomes the one shared "remember something, act on it later" layer. WorkGraph
settlement migrates onto it as the first hosted customer, and the standalone
dispatcher pieces built in plan 001 are absorbed — the DO becomes wakes'
hosted driver, the port shape becomes the `WakeDriver` contract. Nothing from
001 is thrown away; the WorkGraph-only wrappers are deleted only at the very
end, when the wakes path carries the same staging budgets.

Still true from plan 001 (do not re-litigate or retry):

- the three approaches that hang or are illegal on Workers (in-request nudges,
  cross-request promise sharing, self-fetch);
- the tandem shape (fast lane = push nudge, slow lane = cron backstop, both
  into one serialized per-tenant door);
- the latency targets, which the wakes migration must keep green.

## The five fixes wakes needs (verified against the code 2026-07-17)

1. **The store port is synchronous.** `WakeStore` methods return values
   directly (`insert(...): { inserted }`, `cas(...): boolean` —
   `packages/wakes/src/store.ts`). A Convex adapter is network-async, so the
   port and the engine must become async first. Mechanical but touches
   everything.
2. **SQLite-only, and exported from the root.** The only store is
   `better-sqlite3` (Node-only), and `src/index.ts` exports it from the root
   entrypoint — importing `@claxedo/wakes` in a Worker would break the bundle.
   Needs a Convex store and a subpath split (`.` = engine only,
   `./sqlite` = the Node store).
3. **Firing can only send a session prompt.** The engine's single output is
   `spawnTurn` (`wakes.ts` `driveFiring`). Needs a sink registry: each wake has
   a `kind`; the host registers a handler per kind; today's behavior becomes
   the `session_turn` sink.
4. **One global lane.** The scheduler runs everything one-at-a-time
   (`scheduler.ts` "never overlap ticks"). Needs `serialKey`: same key = one at
   a time, different keys = parallel. On Workers the lane must be a Durable
   Object per key (the only legal primitive); on Node it is a per-key promise
   chain.
5. **Polling only.** Creating a due-now wake waits for the next tick. Needs a
   driver port: `schedule()` nudges the driver for that wake's key, and the
   interval/cron sweep is demoted to the backstop.

Plus the trust fix the owner called out: the `CLAXEDO_WAKES` flag stays off
everywhere. Flip it on in local dev first so the package starts collecting
real miles while the rest lands.

## How WorkGraph settlement uses the fixed wakes

The outbox rows in Convex stay exactly as they are — leases, epoch fences,
transactional writes. Wakes never learns what an "effect" is. The division:

- **Outbox row** = WHAT must happen (authoritative, fenced).
- **Wake** = WHEN someone should look (a durable, coalesced dirty flag).

Per WorkGraph command that can enqueue durable work, the same Convex mutation
that writes the domain change also creates (in the same transaction, via the
in-transaction helper from U5):

```
kind:           "workgraph_settle"
serialKey:      "{organizationId}:{ownerUserId}"        (the tenant)
workspaceId:    "wg:{organizationId}:{ownerUserId}"     (wakes requires one; system scope)
fireAt:         now
idempotencyKey: "settle:{organizationId}:{ownerUserId}" (burst of commands → one wake)
budgets:        skipped (system wake, not an agent workspace wake)
```

The `workgraph_settle` sink runs the tenant-scoped reconcile for that tenant.
If rows remain unsettled (sandbox still provisioning), the sink schedules a
follow-up wake for the retry time. The cron backstop asks Convex for tenants
with stale pending rows and creates the same wake for them — lost nudges can
never lose work.

## Implementation units

Order matters for U1; after it, several units run in parallel (see the
dependency map). Every unit keeps `bun run test` + `bun typecheck` green in
`packages/wakes`, and the wakes agent tools' behavior unchanged.

### U0. Flip the flag in local dev (first, per owner)

- Enable `CLAXEDO_WAKES=1` by default for local dev runs of claxedo-server
  (dev script / local env template), keep it opt-in for releases.
- Confirm the 4 agent tools (schedule_followup, watch, request_approval,
  cancel_wake) work in a live local session.

DoD: a local session can schedule a follow-up and gets woken; central-runtime
tests green. Small, no engine changes.

### U1. Async store port + entrypoint split (the foundation)

- Make every `WakeStore` method return a `Promise`; update the engine
  (`wakes.ts`), tools, scheduler, and the SQLite store (sync internals, async
  signatures).
- Update the one wiring site (`central-session-runtime.ts`) and all tests.
- Split exports: root `.` = engine/types/tools only (Worker-safe, no
  better-sqlite3); new `./sqlite` subpath = `SqliteWakeStore`. Fix the import
  in central-session-runtime.
- Keep the package version 0.1.x; it has one consumer, no compat shims.

DoD: wakes tests green (all existing 14 + no sync-API remnants);
`bun typecheck` green in wakes AND claxedo-server; grep proves no
`better-sqlite3` import reachable from the root entrypoint.

### U2. Sink registry (generic firing)

- Add `kind` to `Wake` (default `"session_turn"` for old rows/creators).
- `createWakes({ sinks: { session_turn, ... } })`; `spawnTurn` option becomes
  sugar for the `session_turn` sink. `driveFiring` dispatches by kind; unknown
  kind = fail the fire with a clear error (row stays reclaimable).

DoD: new tests — custom sink fires with the wake payload; unknown kind fails
safely; session tools still produce `session_turn` wakes; recurring wakes keep
their kind.

### U3. Serial keys (per-key lanes)

- Add `serialKey: string | null` to `Wake` and the create inputs.
- Claim rule: `claimDue` must not claim a wake whose `serialKey` already has a
  row in `firing` (null key = today's behavior, no lane).
- Lease reclaim frees the lane (a crashed fire must not block its key
  forever); `recover()` respects lanes.

DoD: tests — two due wakes same key fire strictly one-after-another; different
keys fire concurrently; a lapsed lease frees the lane; both stores (SQLite
now, Convex in U5) pass the same suite.

### U4. Driver port (push, not just poll)

- New port: `WakeDriver { nudge(serialKey | null): void }` — fire-and-forget,
  never throws into the caller.
- `schedule()` (and event/approval resolution) calls `driver.nudge(key)` when
  the wake is due now or newly runnable.
- `runDue(key?)`: optional key filter so a driver can run just its lane.
- Node driver: per-key promise chains that call `runDue(key)`, plus the
  existing interval sweep demoted to backstop (`createScheduler` keeps working
  as the no-driver fallback).

DoD: tests — due-now wake fires without waiting for a tick; N nudges for one
key coalesce; nudge failure leaves the wake claimable by the sweep; no driver
configured = exactly today's polling behavior.

### U5. Convex `WakeStore` adapter + conformance suite

- New tables in `convex/schema.ts` (`wakes`, `wake_receipts`) with indexes for
  due-claims by (fireAt, state) and serialKey lanes.
- Service mutations in a new `convex/wakes.ts` implementing the port
  operations (claim with lease, cas, idempotent insert, receipts, gc) —
  service-token guarded like `workgraphRuntime`.
- JS adapter `ConvexWakeStore` (in claxedo-server, since it composes the
  Convex client) implementing the async port.
- **In-transaction helper**: an exported plain function
  `createWakeInTx(ctx, fields)` usable from other Convex mutations
  (`workgraphCommands`), so domain write + wake are one atomic transaction.
- Conformance: one shared test suite run against SQLite and Convex
  (convex-test or the existing Convex test harness pattern).

DoD: conformance suite green on both stores; `bunx convex dev --once`
typecheck green; the in-transaction helper covered by a Convex test that
proves atomicity (mutation throws after helper → no wake row).

### U6. Durable Object driver in the hosted Worker (adapt what plan 001 built)

The DO already exists: `WORKGRAPH_SETTLER` / the `WorkGraphSettler` class in
`packages/claxedo-server/src/workgraph-host/cloudflare-settlement-dispatcher.ts`,
with its binding and migration in `wrangler.toml`, alarm coalescing, and
backoff. This unit generalizes it into wakes' hosted driver:

- Key the DO by `serialKey` (today it is keyed by tenant — for settlement
  these are the same string, so this is a rename/widening, not a rewrite).
- The alarm calls `wakes.runDue(serialKey)` with the Convex store instead of
  the tenant-scoped reconcile directly (the reconcile becomes the
  `workgraph_settle` sink's job, U8).
- Keep the existing DO tests; extend for the wakes path. Must respect
  `worker.import-graph.test.ts` (engine root + Convex adapter only; no
  `./sqlite`).

DoD: existing DO behavior preserved (coalescing, backoff, restart identity);
alarm drives `runDue`; wrangler dry-run green.

### U7. Tenant-scoped reconcile — DONE (plan 001, commit `aa89411dbe`)

Already landed and tested. Nothing to do; listed so the dependency map stays
honest.

### U8. Migrate settlement onto wakes + retire the standalone wrappers

Plan 001 shipped: nudges fired from the Worker command path (`hosted.ts`),
the `listStaleTenants` backstop, and cron demotion. This unit moves the
trigger into the data layer and the work into a sink:

- `workgraphCommands` mutations that enqueue durable effects/launches call
  `createWakeInTx` with the dirty-flag wake described above (trigger becomes
  atomic with the domain write — an upgrade over the Worker-side nudge).
- Register the `workgraph_settle` sink in the Worker composition: it runs the
  tenant-scoped reconcile for the wake's tenant.
- The cron backstop switches from "nudge stale tenants directly" to "create
  their settle wakes" (same `listStaleTenants` query).
- Only after the wakes path holds the staging budgets (U9): delete the
  standalone `SettlementDispatcher` call sites in favor of the wake creation,
  keeping the port file if the DO still implements it.
- Telemetry trigger tag gains `wake` alongside the existing values.

DoD: hosted-ROUTER regression (never store-only): a delete command atomically
creates the settle wake; wake fire settles the effect; a lost nudge is
recovered by the sweep. Legacy admin route `/internal/workgraph/reconcile`
unchanged. No latency regression against the plan 001 budgets.

### U9. Staging proof (owns the tail)

Plan 001's budgets are already wired into the smoke and the browser gate
(execution start < 10s, bare-Stream deletion settle < 20s, gate deletion
budget 30s, busy-tenant isolation). This unit re-proves them on the wakes
path:

- One ordered staging release with settlement running through wakes;
  shared-worktree push rule applies (build the push ref explicitly, verify
  `git log origin/dev..ref` first).
- Same budgets green, telemetry shows `trigger=wake`, staging cron already
  matches production cadence (plan 001 removes the every-minute lane).

DoD (= the plan's overall DoD): backend smoke green with the latency
assertions on the wakes path; browser gate green with no manual retries; all
repo gates from the goal plan hold; wakes conformance suite green on both
stores.

## Dependency map and parallel execution

```
U0 ──────────────────────────────────────────────► (independent, do first)
U1 ─┬─► U2 ─┐
    ├─► U3 ─┼─► U4 ─┐
    └─► U5 ─┘       ├─► U6 ─┐
U7 ─────────────────┘       ├─► U8 ─► U9
                            │
        (U7 independent) ───┘
```

- U0 has no dependency on the wakes engine — a separate agent can start it
  immediately. U7 is already done (plan 001).
- After U1 lands, U2, U3, and U5 are parallel (different files: engine kinds,
  claim logic, Convex adapter). U4 needs U2+U3.
- Prefer fanning these out to parallel agents with an adversarial review pass
  over the combined diff before pushing. Regressions go through composed
  surfaces (hosted ROUTER for server, the engine's public API for wakes).

## Verification commands

```sh
cd packages/wakes && bun run test && bun typecheck && bun run build

cd ../claxedo-server
bun run test \
  src/workgraph-host/hosted-runtime.test.ts \
  src/workgraph-host/hosted.test.ts \
  src/workgraph-host/reconcile-serialize.test.ts \
  <new: convex-wake-store / wake-lane / settlement tests>
bun typecheck
npx wrangler deploy --dry-run --outdir dist-worker

cd ../workgraph && bun run test && bun typecheck
```

Never run the repo-root test suite (the full claxedo-server vitest suite hangs
locally). claxedo-app UI (`packages/claxedo-app/src/features/workgraph/**`) is
owned by the user — backend only.

## Risks

- **Async port migration ripples.** U1 touches every wakes file + the
  central-runtime wiring. Mitigation: land U1 alone, full green, before
  anything else stacks on it.
- **Wakes tables join the control-plane schema.** A real commitment — Convex
  migrations now cover wakes. Accepted by this decision.
- **Per-fire Convex round-trips.** A fire is claim + cas + receipt (+ sink
  work). Fires are rare (per command burst, coalesced) — fine. Do not build
  batching until measured.
- **DO platform requirements.** DOs need the paid Workers plan (account
  already uses paid features — verify once before U6). Migrations are
  top-level in wrangler.toml — confirm staging env inherits.
- **Unknown-sink or crashed-sink wakes.** Fail the fire, keep the row
  reclaimable, let the sweep retry; never mark `fired` without the sink
  succeeding.
- **`gh run rerun` downgrade trap** (memory): only rerun deploys on the newest
  SHA's run.

## Follow-ups (recorded, not in this plan)

1. Move recap due-times onto wakes `at`-triggers (today: Convex cron re-stamps
   `recap_due_at`, `convex/crons.ts:29`) — after settlement has staging miles.
2. Move recaps / source planning / session intake off the 15-minute global
   pass onto per-tenant wakes.
3. Postgres `WakeStore` adapter (self-host beyond SQLite) via the same
   conformance suite.
4. Wire `authorize` to real authority + approval-push channels (wakes v1
   deferred list).
