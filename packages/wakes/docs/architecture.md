# @claxedo/wakes — Architecture

Grounded in the source as of 2026-07-17 (wakes v2). Every section names the
file and function that implements it; when this doc and the code disagree, the
code wins and this doc has rotted — fix it.

## Source map

| file | lines | owns |
| --- | --- | --- |
| `src/types.ts` | ~114 | every public type: `Wake`, states, triggers, `WakeSink`, `WakeDriver`, `Budgets` |
| `src/store.ts` | ~58 | the `WakeStore` port — the only surface adapters implement |
| `src/wakes.ts` | ~398 | the engine: create paths, the guarded firing path, `runDue`, recovery, receipts |
| `src/scheduler.ts` | ~49 | the polling backstop for long-lived processes |
| `src/sqlite-store.ts` | ~278 | better-sqlite3 adapter (schema, claim SQL, additive upgrades) |
| `src/sqlite.ts` | 5 | the node-only subpath entry (`@claxedo/wakes/sqlite`) |
| `src/tools.ts` | ~166 | agent-facing tool definitions + dispatcher |
| `src/budgets.ts` | ~47 | per-workspace creation limits |
| `src/token.ts` | 13 | 128-bit Web-Crypto approval tokens |
| `src/index.ts` | ~33 | root entry — **must stay edge-runtime-safe** (no sqlite) |

Tests: `test/wakes.test.ts` (core lifecycle, durability, budgets, durations),
`test/sinks.test.ts` (kind registry), `test/lanes.test.ts` (serialization),
`test/reclaim-race.test.ts` (concurrent reclaim), `test/tools.test.ts`
(agent surface).

## The wake row (`types.ts` — `Wake`, line ~37)

One durable record: *when trigger T fires, run sink K with this payload.*

- `triggerType: "at" | "on_event" | "on_approval"` — WHEN. Time (one-shot or
  cron), a delivered event key, or a tokened human approval.
- `kind: WakeKind` (default `"session_turn"`) — WHAT: selects the sink.
- `serialKey: string | null` — WHICH lane. Same-key wakes never fire
  concurrently; null = unlaned.
- `intentJson` — opaque payload handed to the sink.
- `resultJson` — set at claim time for event/approval fires so a re-drive
  after a crash reconstructs the exact result (the approver's answer
  survives).
- `state: pending → firing → fired` (terminal alternatives: `expired`,
  `cancelled`).
- `leaseUntil`, `attempts` — crash-recovery bookkeeping.
- `idempotencyKey` — create-time dedup (see the sharp edge below).

## Lifecycle — who performs each transition

```
                    insertWake (wakes.ts)            every transition out of
   create ────────────► pending                      `pending` is a guarded
                        │  │  │                      CAS: store.cas(id, from,
     fireFromPending ───┘  │  └── cancel()           to) applies ONLY if the
     (claim: CAS           │      pending→cancelled  row is still in `from`.
      pending→firing,      └── runDue expiry pass:   Exactly one winner.
      stamps lease,            pending→expired,
      persists result)         then sink fires the
             │                 expired:true result
             ▼
          firing ──── driveFiring: sinkFor(wake) runs, then CAS firing→fired
             │
   crash?    │  lease lapses → reclaimFiring → driveFiring re-drives
             ▼
           fired  (+ recurring: next occurrence inserted, see below)
```

- `fireFromPending` (`wakes.ts`): the claim. CAS `pending→firing` with
  `leaseUntil = now + leaseMs` (default 30s) and the serialized result.
- `driveFiring` (`wakes.ts`): resolve the sink **before any side effect**
  (`sinkFor` throws on an unregistered kind → the row stays in `firing`,
  reclaimable — never a half-fire), run it, CAS `firing→fired`.
- `recover()` re-drives every `firing` row on boot; `runDue`'s reclaim pass
  re-drives lapsed leases at any time. Firing is therefore **at-least-once**;
  `once()` + `effect receipts` (store `getReceipt`/`putReceipt`) give
  at-most-once for irreversible external effects.

## The engine (`wakes.ts` — `createWakes`, line ~119)

Options: `store` (required), `spawnTurn` (sugar for the `session_turn` sink),
`sinks` (kind → handler; at least one of spawnTurn/sinks required), `driver`
(optional push), `authorize` (approval guard), `budgets`, `now` (injectable
clock — all tests are wall-clock-free), `computeNextRun` (cron math, injected,
see shortcoming), `leaseMs`, `batchLimit`.

**Create paths** — `schedule` / `watch` / `requestApproval` all funnel into
`insertWake`, which: enforces budgets (unless the recurring re-insert), dedups
by `idempotencyKey`, writes the row (`wake_${ulid()}`), and for `schedule`
nudges the driver with `{serialKey, fireAt}`.

**Relative times**: `schedule({in: "3d"})` and `expiresIn: "12h"` use the `ms`
package; `DurationString = Parameters<typeof ms>[0]` gives compile-time
checking, with a runtime `duration()` guard for anything the type misses.
Absolute `at`/`expiresAt` take precedence. Rows always store epoch-ms.

**`runDue(serialKey?)`** — the one entry point both fire mechanisms call:

1. *(unscoped runs only)* expiry pass: `findExpirable` → CAS
   `pending→expired` → fire the sink with `{..., expired: true}`.
2. reclaim pass: `reclaimFiring(now, leaseMs, serialKey)` — an atomic
   re-stamp-and-return, so two runners never re-drive the same lapsed row.
3. claim pass: `claimDue(now, leaseMs, batchLimit, serialKey)` → drive each.

A scoped run (`serialKey` given — string for one lane, `null` for the
null-key lane) skips expiry and touches only that lane; that is what a push
driver calls.

**Recurring** (`driveFiring`): the next occurrence is computed from the
wake's OWN `fireAt` (never wall-clock-at-fire → no drift) and inserted with
idempotency key `recur:${id}:${nextFireAt}` (re-drives can't double-book),
preserving `kind` and `serialKey`. Downtime therefore *replays* missed
occurrences one by one.

## The store port (`store.ts`)

All methods async so a network adapter (Convex) fits the same contract as an
embedded one (SQLite). Three operations carry the correctness burden:

- `insert` — idempotency-keyed dedup must be atomic.
- `cas(id, from, to, patch)` — the single serialization point per wake.
- `claimDue(now, leaseMs, limit, serialKey?)` — atomic claim **honoring
  lanes**: never claim a key that already has a `firing` row; at most one
  wake per key per batch (earliest first); null keys unrestricted; the
  optional `serialKey` scopes to one lane (string), the null lane (`null`),
  or all (`undefined`).

Everything else is plain reads. Because claims are atomic *in the database*,
any number of racing runners (ticks, alarms, machines, regions) are safe:
duplicates lose the CAS/claim and do nothing.

### SQLite adapter (`sqlite-store.ts`)

Synchronous better-sqlite3 internals behind async signatures. WAL +
busy_timeout at open; `CREATE TABLE IF NOT EXISTS` plus guarded additive
`ALTER TABLE`s for columns added after v1 (`kind`, `serial_key`) — no
migration framework. The lane-aware claim is one atomic UPDATE:

```sql
UPDATE wakes SET state='firing', lease_until=?, attempts=attempts+1
WHERE id IN (
  SELECT id FROM (
    SELECT id, fire_at,
           ROW_NUMBER() OVER (PARTITION BY COALESCE(serial_key, id)
                              ORDER BY fire_at ASC, id ASC) AS lane_rank
    FROM wakes
    WHERE trigger_type='at' AND state='pending'
      AND fire_at IS NOT NULL AND fire_at <= ?
      [AND serial_key = ? | AND serial_key IS NULL]      -- lane scope
      AND (serial_key IS NULL OR serial_key NOT IN (
        SELECT serial_key FROM wakes
        WHERE state='firing' AND serial_key IS NOT NULL))
  ) WHERE lane_rank = 1
  ORDER BY fire_at ASC LIMIT ?
) RETURNING *
```

`PARTITION BY COALESCE(serial_key, id)` puts every null-key wake in its own
partition (no lane); `lane_rank = 1` enforces one-per-key-per-batch; the
`NOT IN` subselect blocks a lane whose previous fire is still running.

### Convex adapter (out-of-package, listed for the map)

`convex/wakes.ts` (repo root) implements every port op as a
service-token-guarded Convex function with the same lane semantics inside one
Convex transaction, plus two extras the port doesn't have: `createWakeInTx`
(create a wake atomically inside another mutation's transaction) and
`createLaneWakeIfIdle` (state-aware "skip if a pending wake of this kind
already holds the lane"). The thin client is
`packages/claxedo-server/src/hosts/wakes/convex-wake-store.ts`.

## Drivers — the push path (`types.ts` `WakeDriver`)

Contract: `nudge({serialKey, fireAt})` is a **lossy hint** — may be dropped,
duplicated, late; must never throw into the caller (the engine additionally
wraps it). The sweep is the delivery guarantee; the driver is only speed.
`fireAt` may be in the future so timer-capable drivers (DO alarms) can arm
precisely. Node runs no driver — the 1s scheduler poll is prompt enough
there, so the only driver implementation is hosted.

The Cloudflare driver lives in
`packages/claxedo-server/src/deployments/hosted-workerd/wake-lane.cf.ts`: one `WakeLane` Durable
Object per lane. Its `nudge` handler only arms the DO alarm (earliest wins);
ALL work happens in `alarm()` — drain the lane, bounded self-retry with
backoff on failure. DO alarms are platform-persisted (survive deploys and
machine loss, retried on throw); the platform never runs two alarms for one
object concurrently, so per-lane serialization is physically guaranteed.
Wakes that a sink schedules mid-drain re-arm the object's own alarm via an
in-DO driver, so lane-local retries never wait for the sweep.

## The scheduler — the guarantee (`scheduler.ts`)

`createScheduler(wakes)`: on `start()`, run `recover()` once, then a
non-overlapping `runDue()` tick every `intervalMs` (default 1000). This is
the Node backstop; the hosted equivalent is a Cloudflare Cron Trigger calling
the same logic. Neither needs to be precise — only inevitable.

## Agent tools (`tools.ts`)

Two definitions (`schedule_followup`, `cancel_wake`) plus
`handleWakeToolCall`, a pure dispatcher. Event/approval tools are deliberately
absent until a host wires delivery paths for `deliverEvent`/`resolve` — a tool
that promises a resumption no host can deliver is worse than no tool. Security
properties enforced by construction: sessionId/workspaceId come from the
host-supplied `WakeToolContext`, never from the agent (a tool can only touch
its own session's wakes — `cancel_wake` checks `listForSession` ownership);
`toolCallId` becomes the idempotency key so a retried tool call can't
double-book; `depth+1` flows into the budget recursion bound. Its `parseWhen` accepts
`"+3d"`-style strings and ISO dates (predates the `ms` sugar; intentionally
unchanged).

## Budgets (`budgets.ts`) and tokens (`token.ts`)

Budgets bound agent-authored creation per workspace: max live pending
(default 1000), creation rate/hour (240), schedule horizon (90d), and
self-schedule depth (5) — enforced in `insertWake`, skipped only for the
recurring re-insert. `BudgetError.reason` tells you which. Tokens are 16
random bytes, hex, via Web Crypto — possession + `authorize()` is the
approval guard.

## Packaging and the edge-safety invariant

Two entries, built by `scripts/build.ts` (bun bundles with
`--packages=external`, tsc emits declarations):

- `"."` → `dist/index.mjs` — engine, drivers, tools, types. **Invariant: no
  node-only imports reachable from here** (its only runtime deps are `ulid`
  and `ms`, both pure JS) so it bundles into a Cloudflare Worker. Check:
  `grep -c better-sqlite3 dist/index.mjs` must be 0.
- `"./sqlite"` → `dist/sqlite.mjs` — `SqliteWakeStore` only.

`dist/` is gitignored: consumers in-repo build it (CI's deploy workflow runs
`bun run --cwd packages/wakes build` before bundling the Worker).

## Consumers today

**Local Node server** (`packages/claxedo-server/src/session/runtime.ts`,
on by default under `bun run dev` via `CLAXEDO_WAKES`): SQLite store,
`spawnTurn` = post an injected message into the session, scheduler started,
the four tools exposed per-turn, `wakes` returned for the channels/webhook
layer (`deliverEvent`/`resolve`).

**Hosted WorkGraph settlement** (`packages/claxedo-server/src/hosts/wakes/`,
staging-only via `CLAXEDO_WAKES_SETTLEMENT=1`): wakes is the *doorbell*, the
lease/epoch-fenced outbox in Convex stays the truth. Per command burst, one
dirty-flag wake per tenant (`kind: workgraph_settle`, `serialKey` = tenant,
`fireAt: now`; created via the state-aware `createLaneWakeIfIdle`, NOT an
idempotency key — see sharp edges). The sink (`hosted-wakes.ts`) runs the
tenant-scoped reconcile and converts "still provisioning, retry in Nms"
results into durable retry wakes on the same lane. Staging latency proof:
release run 29559022315 (placement <10s, deletion <20s through this path).

## Guarantees and failure semantics

- **Never early; close-to-on-time normally; late-but-never-lost worst case.**
- Crash mid-fire → lease lapse → reclaim by any runner. The result payload
  was persisted at claim, so nothing is reconstructed from memory.
- Process down (Node) → rows wait on disk; boot runs recover + catch-up;
  expiries that lapsed fire their `expired: true` notification instead.
- Deploys/evictions (hosted) → DO alarms and cron schedules live in platform
  storage/config; nothing in-memory is load-bearing.
- Multi-machine/multi-region → safe because ALL coordination is the store's
  atomic claim + CAS and the DO's single-location guarantee; runners can race
  freely. Multi-machine requires a shared store (Convex; SQLite is one box).

## Sharp edges (the load-bearing ones; full list in the README)

1. **Idempotency keys dedup forever** — including against `fired` rows. They
   protect retried creates; they cannot express "at most one pending per
   lane." Use a state-aware create (as settlement does) for that.
2. **Lanes bind time-triggered claims only** — `deliverEvent`/`resolve` fire
   through the CAS without lane queuing.
3. **A throwing wake aborts the rest of its `runDue` pass** — by design
   (crash model), but a persistently poisoned wake starves its pass; there is
   no dead-letter state yet, only the `attempts` counter.
4. **`computeNextRun` (cron parsing, timezones, DST) is injected and nowhere
   wired in production** — only absolute-time wakes run in real deployments
   today.
5. **`gc()` has no caller yet** on either deployment; terminal rows
   accumulate until it's wired to a periodic lane.
6. **The Convex adapter is proven by an in-memory mirror**
   (`convex-wake-store.test.ts`) plus the staging smoke — the mirror and
   `convex/wakes.ts` must be changed together or they drift silently.

## Extension recipes

- **New firing behavior**: add `sinks: { my_kind: (wake, result) => … }` at
  the composition that runs the engine, create with `kind: "my_kind"`. Deploy
  order is safe either way: rows with an unregistered kind fail-before-effect
  and retry once the sink ships.
- **New store adapter**: implement `WakeStore` (get the three hard ops right,
  especially the lane rules in `claimDue`); run the behavioral suites in
  `test/` against it — they are store-agnostic by construction.
- **New driver**: implement `nudge` as a lossy hint honoring "never throw";
  call `runDue(serialKey)` from whatever timer/queue you own; leave the sweep
  running as the guarantee.
