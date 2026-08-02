# @claxedo/wakes

A durable alarm clock: write down "run this later, when X happens," and the
package guarantees it runs — effectively once, across crashes, deploys, and
machines — without caring *what* "this" is or *where* it runs.

No resident process required, no durable-execution engine. Durable state is a
database's job and durable timers are the platform's job; this package is the
thin, tested logic connecting them: claims, leases, lanes, and sinks.

```ts
import { createWakes, createScheduler, createNodeWakeDriver } from "@claxedo/wakes"
import { SqliteWakeStore } from "@claxedo/wakes/sqlite" // node-only subpath

const driver = createNodeWakeDriver()
const wakes = createWakes({
  store: new SqliteWakeStore({ path: "wakes.db" }),
  driver,                                             // push (optional)
  spawnTurn: async (sessionId, result) => host.resumeSession(sessionId, result),
  sinks: {                                            // other firing behaviors
    my_job: async (wake, result) => host.runJob(JSON.parse(wake.intentJson)),
  },
  authorize: async (actor, workspaceId) => host.canApprove(actor, workspaceId),
  computeNextRun: (cron, after) => parseCron(cron, after), // only if you use cron
})
driver.bind(wakes)

// three trigger types — durations are compile-checked `ms` strings
await wakes.schedule({ workspaceId, sessionId, in: "3d", intent })          // or at: Date | epoch-ms
await wakes.watch({ workspaceId, sessionId, eventKey: "ci:pass:x", intent, expiresIn: "7d" })
const { token } = await wakes.requestApproval({ workspaceId, sessionId, prompt, expiresIn: "1d" })

// fire sources
createScheduler(wakes).start()                 // the polling backstop (guarantee)
// + the driver fires due-now wakes instantly  // the push path (speed)
await wakes.deliverEvent("ci:pass:x", payload) // 'on_event' — host webhook ingress
await wakes.resolve(token, answer, actor)      // 'on_approval' — inbound handler

// turn-side: make an irreversible external effect at-most-once across re-runs
await wakes.once(sessionId, "open-pr:branch-x", () => host.openPr(branch))
```

## The model

A **wake** is one durable row:

| field | meaning |
| --- | --- |
| `triggerType` | WHEN it fires: `at` (time/cron), `on_event` (delivered key), `on_approval` (human answer via token) |
| `kind` | WHAT firing does: selects a registered sink (default `session_turn`) |
| `serialKey` | WHICH lane: same-key wakes never fire concurrently; null = no lane |
| `intentJson` | the payload handed to the sink |
| `state` | `pending → firing → fired` (or `expired` / `cancelled`) |
| `leaseUntil`, `idempotencyKey` | crash-recovery and create-dedup bookkeeping |

Every transition out of `pending` is a guarded compare-and-swap — the single
serialization point. Whoever wins the CAS fires; everyone else backs off. A
crash mid-fire leaves the row in `firing` with a lease; when the lease lapses,
any runner reclaims and re-drives it (the result payload was persisted at
claim time, so an approval's answer survives the crash). Firing is
**at-least-once**; `once()` receipts and idempotency keys make effects
at-most-once where it matters.

## The five pluggable pieces

```
             ┌────────────────── ENGINE (wakes.ts) ──────────────────┐
  create ──► │ schedule/watch/requestApproval · runDue · recover     │ ──► fire
             └──────┬────────────────┬──────────────────┬────────────┘
                    │                │                   │
             STORE (port)      SINKS (by kind)     DRIVER (push, optional)
             where rows live   what firing does    who notices due wakes fast
             ├ SqliteWakeStore ├ session_turn      ├ Node: per-lane promise chains
             └ ConvexWakeStore └ anything you      └ Cloudflare: WakeLane
               (claxedo-server)  register            Durable Object (alarms)
        + SCHEDULER: the polling backstop (setInterval here; platform cron hosted)
        + TOOLS: agent-facing defs + dispatcher (schedule_followup, watch,
          request_approval, cancel_wake) — host wires them onto its tool surface
```

**Store** (`WakeStore`, all-async): owns the two hard operations — the CAS and
`claimDue`, the atomic "grab due wakes respecting lanes." Because claims are
atomic in the database, any number of runners (ticks, alarms, machines,
regions) can race safely: duplicates waste a read, never double-fire.

**Sinks**: plain in-process functions registered at `createWakes` time, keyed
by the `kind` *string* stored on the row. No code in the database, no RPC — a
wake created last week fires with this week's reviewed implementation. An
unregistered kind fails **before** any side effect, leaving the row
lease-reclaimable (deploy the sink, it fires on the next attempt). Sinks are
closures: they may schedule new wakes through the same engine (durable
retries).

**Lanes** (`serialKey`): `claimDue` never claims a key that already has a
`firing` row and takes at most one wake per key per batch (earliest first), so
same-key ordering is a property of the data layer, not of any process. A
lapsed lease frees its lane; other lanes are never blocked.

**Driver** (`WakeDriver`): `nudge({serialKey, fireAt})` — a lossy hint, never
load-bearing. The engine nudges on every time-triggered create (including
sink-scheduled retries). Node driver: in-memory lane chains that drain each
lane until empty; future hints are dropped (the sweep owns them). Cloudflare
driver: the `WakeLane` DO arms a *durable platform alarm* at `fireAt` — it
survives deploys, evictions, and machine loss, and the platform retries it.

**Scheduler**: the guarantee. `createScheduler` = recover-on-boot + a
non-overlapping `runDue()` interval on Node; a Cloudflare Cron Trigger plays
the same role hosted. Slow, dumb, cannot miss.

## Timing semantics (read this before trusting the clock)

- **Never early, close-to-on-time normally, late-but-never-lost worst case.**
  This is reliable scheduling, not hard-realtime.
- Recurring wakes compute the next occurrence **from the wake's own scheduled
  time**, never from wall-clock-at-fire — so slack never drifts the grid — and
  the next-occurrence insert is idempotency-keyed, so replays can't double-book.
- Downtime **replays** missed recurring occurrences one by one on recovery (no
  skip-to-latest mode yet). Expiring wakes that lapsed during downtime fire
  their `expired: true` notification instead of the normal result.
- A stopped Node process fires nothing until it's back (the scheduler lives in
  the process; rows wait safely on disk). "Fires while my laptop is closed"
  requires the hosted runner by definition.

## How WorkGraph uses it (the first hosted consumer)

WorkGraph settlement keeps its own truth (lease/epoch-fenced outbox rows in
Convex) and uses wakes only as the **doorbell**: per command burst, one
dirty-flag wake per tenant (`kind: workgraph_settle`, `serialKey` = tenant,
`fireAt: now`, intent = the tenant identity). Firing runs the tenant-scoped
reconcile; unsettled results (sandbox still provisioning) schedule a durable
retry wake on the same lane. The `WakeLane` DO gives per-tenant serialization
that is physically guaranteed by the platform; the 15-minute reconcile cron
remains the universal backstop. See
`packages/claxedo-server/src/wakes-host/`.

Burst coalescing there is **state-aware** (skip creating when a *pending*
settle wake already holds the lane — `createLaneWakeIfIdle` in
`convex/wakes.ts`), NOT via engine idempotency keys — see shortcoming #1.

## Shortcomings and sharp edges (honest list, 2026-07-17)

1. **Engine idempotency keys dedup forever, including against fired wakes.**
   They exist to make *retried creates* safe, not to coalesce recurring
   intent. A reused key like `settle:{tenant}` silently swallows every create
   after the first fire. For "at most one pending per lane," do a state-aware
   check at create time (as WorkGraph does).
2. **Cron expressions have no parser wired.** The engine delegates
   next-occurrence math to the injected `computeNextRun`; no deployment
   injects a real parser yet (tests use a stub). Timezones/DST are therefore
   unhandled until a parser is chosen. Absolute-time (`at:`) wakes need none
   of this.
3. **Lanes apply to time-triggered claims only.** `deliverEvent` and
   `resolve` fire immediately via the CAS guard and do not queue behind a
   lane; a serial-keyed event wake can fire while a same-key `at` wake is
   firing. Fine for current consumers; extend `fireFromPending` if a consumer
   ever needs laned events.
4. **A failing wake in `runDue` aborts the rest of that pass** (the crash
   model is throw-and-let-the-lease-retry). One persistently poisoned wake can
   starve its pass until an operator intervenes — attempts are counted but
   there is no dead-letter state yet.
5. **`gc()` must be called by the host or terminal rows accumulate forever.**
   The bounded delete exists (`gcWakes` on Convex, `gc()` everywhere); wire it
   to a periodic lane (not yet done on either deployment as of 2026-07-17).
6. **SQLite store = one machine.** Multi-machine runners require the shared
   store (Convex today; a Postgres adapter is a designed-but-unbuilt port
   implementation, held to the same conformance expectations).
7. **The Convex store's logic is proven by an in-memory mirror + the staging
   smoke, not by an in-repo Convex runtime** (no convex-test harness in this
   repo). The mirror in `convex-wake-store.test.ts` must be updated with
   `convex/wakes.ts` — they drift silently otherwise.
8. **Budgets protect against runaway agents, not system loops.** The hosted
   settlement instance disables them wholesale; a buggy sink that reschedules
   itself unboundedly is limited only by its backoff and the lane window.
9. **No skip-to-latest for recurring catch-up** (see timing semantics) — a
   small engine option away if a consumer needs it.
10. **Observability is thin.** No per-wake metrics or firing-latency
    histograms; hosted settlement telemetry still tags wake-driven runs as
    `trigger: "nudge"`. Errors surface via the host's `reportError`/`onError`
    only.

## Deployment cheat sheet

| | Local / self-host Node | Hosted Cloudflare Worker |
| --- | --- | --- |
| Store | `@claxedo/wakes/sqlite` | `ConvexWakeStore` (claxedo-server) |
| Push | `createNodeWakeDriver` | `WakeLane` Durable Object |
| Backstop | `createScheduler` (1s tick) | Cron Trigger (15 min) |
| Sinks | `session_turn` (agent tools) | `workgraph_settle` |
| Down = | fires on next boot (recover + catch-up) | platform alarms/cron; no process of ours needs to be alive |

**Deep dive:** [`docs/architecture.md`](./docs/architecture.md) — the
code-grounded walkthrough (source map, lifecycle transitions with their
implementing functions, the claim SQL, driver internals, consumers, test map,
extension recipes).

The original v1 design (durable rows, three trigger types, host seams) evolved
into v2 (async port, sinks, lanes, drivers, Convex store, DO) as part of
migrating WorkGraph settlement onto the shared wakes engine described above.

## License

MIT
