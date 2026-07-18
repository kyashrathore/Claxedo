---
title: "WorkGraph Event-Driven Settlement — Fast Lane + Cron Backstop"
type: feat
date: 2026-07-17
status: executing
followed_by: docs/plans/2026-07-17-002-feat-wakes-v2-settlement-plan.md
execution: code
progress: >
  U1-U5 implemented and verified locally 2026-07-17 (commits aa89411dbe,
  a078d23187, 90775cc1ce, 48d3f69de3, edeee73688, a7f37766a0, 92e03f0ef3,
  757fd838cd — 110 focused tests green, wrangler dry-run green with the
  WORKGRAPH_SETTLER Durable Object). U6 staging proof pending. Follow-up 1
  (wakes v2 convergence) is now its own plan (see followed_by): the
  dispatcher built here becomes wakes' driver.
inputs:
  - docs/plans/2026-07-16-003-workgraph-staging-debug-handoff.md
  - docs/plans/2026-07-13-001-goal-execute-workgraph-end-to-end.md
  - docs/plans/2026-07-07-006-feat-wakes.md
---
# WorkGraph Event-Driven Settlement — Fast Lane + Cron Backstop

## The problem, in plain words

When a user deletes a Stream or executes one, the request only writes a durable
"to-do" row (an outbox row) in Convex. A background job — the reconciler — later
reads those rows and does the real work: start a sandbox, or interrupt sessions
and release a sandbox.

Today the only trigger for the reconciler is a Cloudflare cron. Measured on
staging 2026-07-16:

- Best case: a bare Stream deletion finished in ~111 seconds.
- Busy case: a deletion during load took **more than 300 seconds**, because one
  reconcile pass walks EVERY tenant and polls every running Session, a pass can
  take minutes, and the skip-if-busy guard means a row written mid-pass can wait
  for up to two full passes.

The UI part is already fixed (deleted Streams disappear instantly, commit
`69e4189cdc`). This plan is about the real work starting fast.

## What we already tried that does NOT work (do not retry these)

Learned the hard way on staging (see the handoff doc and memory
`project_workgraph_staging_debug`):

1. **Running a reconcile at the end of each command request.** Overlapping
   reconciles in one isolate hung the Workers runtime completely (run
   29514161976).
2. **Sharing one in-flight reconcile promise across requests.** The Workers I/O
   model forbids using a promise created in request A from request B.
3. **The Worker fetching its own URL to hand off work.** Self-fetch is not
   allowed on Workers.

The lesson: on Cloudflare Workers there is no in-memory way to say "run this
soon, once, without overlap." The only legal primitive for that is a Durable
Object.

## The design: two triggers, one door

We keep the durable rows exactly as they are. We add a **fast lane** and demote
the cron to a **backstop**. Both lanes end at the same serialized, per-tenant
settle function.

```
User command ──► Worker request handler
                   ├─► Convex: write the outbox row   (unchanged — this is the truth)
                   └─► dispatcher.nudge(tenant)       (new — a cheap "wake up" hint)

Fast lane:  nudge ──► per-tenant settler ──► claim + settle THAT tenant's rows
Slow lane:  cron  ──► "any pending rows older than a minute?" ──► nudge those tenants
```

Rules that make this safe:

- **The nudge is a hint, never the truth.** A lost, duplicated, or late nudge
  can never lose work — the cron sweep reads the rows themselves.
- **One door.** All triggers funnel into one settle function per tenant that is
  serialized (never two at once for the same tenant). Different tenants run in
  parallel, so one busy tenant cannot slow down another. This directly removes
  the two failure modes above: no overlap (the hang) and no global pass (the
  300s wait).

### The dispatcher is a port, not a Cloudflare feature

The control plane deploys anywhere (Worker for hosted, Node for self-host and
local dev). So the new piece is a small interface with one adapter per runtime:

```ts
// packages/claxedo-server/src/workgraph-host/settlement-dispatcher.ts
export type SettlementTenant = { organizationId: string; ownerUserId: string }
export interface SettlementDispatcher {
  /** Fire-and-forget. Must never throw into the caller and never block the response. */
  nudge(tenant: SettlementTenant): void
}
```

| Runtime | Adapter | Why |
| --- | --- | --- |
| Cloudflare Worker (hosted) | Durable Object with an alarm, one per tenant | The only legal "run soon, serialized" primitive on Workers |
| Node (local dev, self-host) | In-memory per-tenant promise chain | A normal process has none of the Workers restrictions; ~20 lines |
| Anywhere (fallback / tests) | No-op | The cron backstop alone is exactly today's behavior |

The Durable Object holds **no durable truth**. It is a timer and a lock. If the
whole DO namespace were deleted, the system falls back to cron speed and loses
nothing.

### Relationship to `@claxedo/wakes` (do not merge now, converge later)

Wakes (`packages/wakes`) is our agent-facing "park and fire later" package. It
has the same durability pattern and the same missing piece (its driver also
polls). We are NOT building settlement on wakes now because wakes cannot run in
the Worker (SQLite-only store), can only fire session prompts, has no per-key
serialization, and is feature-flagged with zero production use.

But the dispatcher contract in this plan is written to become wakes' future
driver: "nudge(key) → run the due work for that key, serialized." When wakes v2
lands (Convex store, generic sinks, serial keys), settlement's nudge call sites
swap to it in a few lines. Nothing built here is throwaway.

## Grounding facts (verified 2026-07-17 in this worktree)



## Scope



## Implementation units

Each unit has its own definition of done (DoD). Run units U1–U3 first (they are
pure Node code, testable locally). U4 and U5 build on them. U6 is the staging
proof and owns the tail.

### U1. Tenant-scoped reconcile

Refactor `reconcile()` so it can run for an explicit tenant list instead of
always sweeping the world:

- `reconcile(run?: { background?: boolean; tenants?: WorkerTenant[] })` — when
  `tenants` is given, skip `listWorkerTenants` and run every existing stage for
  only those tenants. No stage logic changes; only the tenant source.
- Reorder nothing else. (Control effects staying in the background phase is
  fine once the pass is one tenant — the whole pass is small.)

DoD:
- New unit tests in `hosted-runtime.test.ts`: a tenant-scoped run claims and
  settles only that tenant's launches and control effects, and never calls
  `listWorkerTenants`.
- Existing reconcile tests unchanged and green.
- `cd packages/claxedo-server && bun run test src/workgraph-host/hosted-runtime.test.ts && bun typecheck` green.

### U2. The dispatcher port + Node + no-op adapters

- New file `settlement-dispatcher.ts` with the interface above.
- Node adapter: `Map<tenantKey, Promise>` chain; each nudge appends "run
  tenant-scoped reconcile for this tenant" to that tenant's chain; a nudge while
  one is queued coalesces (at most one queued run per tenant); errors are
  reported via `reportError`, never thrown to the caller.
- No-op adapter for compositions without a dispatcher.

DoD:
- Contract tests: serialization per tenant (never two concurrent runs for one
  tenant), parallelism across tenants, coalescing, error isolation.
- `bun run test src/workgraph-host/settlement-dispatcher.test.ts && bun typecheck` green.

### U3. Nudge on every successful WorkGraph command

- In the hosted command path (`workgraph-host/hosted.ts` composition), after any
  successful WorkGraph command mutation, call `dispatcher.nudge(tenant)`.
  Nudging on every command is deliberate: it is cheap, the adapter coalesces,
  and it avoids maintaining a list of "which commands enqueue effects."
- The nudge must not delay or fail the HTTP response (fire-and-forget; on
  Workers wrap the DO call in `ctx.waitUntil`).
- Tag reconcile telemetry with the trigger source (`nudge` vs `cron`) in
  `operational-telemetry.ts` so staging latency is measurable.

DoD:
- Hosted-router regression (through `createHostedWorkGraph().router`, per the
  standing rule — never store-only): a delete command results in one nudge with
  the correct tenant; a failing command does not nudge; a nudge failure does
  not change the HTTP response.
- `bun run test src/workgraph-host/hosted.test.ts && bun typecheck` green.

### U4. The Durable Object adapter (hosted fast lane)

- New DO class (e.g. `WorkGraphSettler`) exported from `worker.ts`, binding
  `WORKGRAPH_SETTLER`, `new_classes` migration in `wrangler.toml` (top-level;
  migrations are shared across environments — verify staging picks it up).
- ID = `idFromName("{organizationId}:{ownerUserId}")`.
- `nudge` handler: persist the tenant identity in DO storage (first time), then
  `setAlarm(now)` only if no earlier alarm is set. That is the whole handler.
- `alarm()` handler does ALL the work: compose the hosted services from `env`
  (cache per DO instance, same pattern as `buildApp`), run the tenant-scoped
  reconcile for this tenant, and if anything is still unsettled (e.g. sandbox
  says "provisioning, retry in N ms") re-arm the alarm for that time, capped
  with backoff (e.g. max every 30s, give up re-arming after ~10 minutes — the
  cron backstop owns anything older).
- Serialization comes from doing work ONLY in `alarm()`: Cloudflare never runs
  two alarm handlers for one object at once, and alarms auto-retry on throw.
  `nudge` never runs the reconcile itself.
- The DO must NOT import anything Node-only; it lives in the same Worker bundle
  (respect `worker.import-graph.test.ts`).

DoD:
- Unit tests with injected fakes for the DO logic (alarm coalescing: N nudges →
  one alarm; re-arm on partial settle; backoff cap; tenant identity survives a
  simulated restart via storage).
- `npx wrangler deploy --dry-run --outdir dist-worker` succeeds with the DO
  binding and migration.
- `bun typecheck` green.

### U5. Demote the cron to a backstop sweep



DoD:
- Convex test for `listStaleTenants` (fresh rows excluded, stale rows included,
  tenant dedup).
- Worker scheduled-handler test: stale tenants get nudged; no global reconcile
  on the fast lane.
- `bun run test <the touched server files> && bun typecheck` green in
  `packages/claxedo-server`; `bunx convex dev --once` typecheck path green.

### U6. Staging proof and cron cleanup (owns the tail)

- One ordered staging release (push to dev → Convex → relay → control plane →
  backend smoke → app deploy → browser gate). Follow the shared-worktree push
  rule: build the push ref explicitly and verify `git log origin/dev..ref`
  lists only intended commits.
- Extend `scripts/smoke/smoke-workgraph.ts` to measure and assert:
  - execution placement: attempt claimed/launch started **< 10s** after the
    execute command (was: up to a cron pass);
  - deletion: control effect settled (sessions interrupted + lease released)
    **< 20s** after the delete command for a bare Stream;
  - a deletion for tenant B while tenant A is busy settles in the same budget
    (the per-tenant isolation claim — the smoke already has two users/orgs).
- Tighten the deployed browser gate's card-deletion budget from 150s to 30s.
- After the gate is green with the new budgets: remove the staging
  `* * * * *` lane and re-run the release to prove nothing regressed.

DoD (this is the plan's overall definition of done):
- Backend smoke green with the new latency assertions on the deployed staging
  control plane.
- Deployed browser gate green with the 30s deletion budget, no manual retries
  (a Clerk 429 on retry counts as infra noise per the handoff, but the first
  attempt must carry the product evidence).
- Staging `wrangler.toml` no longer has the every-minute lane; the 15-minute
  lane remains.
- Telemetry shows `trigger=nudge` for the fast-path settlements.
- All repo gates from the goal plan hold: WorkGraph package tests, claxedo-server
  focused suites + typecheck, app typecheck/ratchets, `git diff --check`.

## Verification commands

```sh
# Focused local gates (run from the owning package, never the repo root)
cd packages/claxedo-server
bun run test \
  src/workgraph-host/hosted-runtime.test.ts \
  src/workgraph-host/settlement-dispatcher.test.ts \
  src/workgraph-host/hosted.test.ts \
  src/workgraph-host/reconcile-serialize.test.ts
bun typecheck
npx wrangler deploy --dry-run --outdir dist-worker

cd ../workgraph && bun run test && bun typecheck

# Staging release + evidence
gh run list --repo kyashrathore/Claxedo --branch dev --limit 5
gh run watch <RUN_ID> --repo kyashrathore/Claxedo --exit-status
```

## Risks and how we handle them

- **DO alarm handler crashes repeatedly** → alarms auto-retry with platform
  backoff; our re-arm cap stops storms; the cron backstop settles anything the
  DO gives up on. Failure mode = today's latency, never lost work.
- **Nudge lands before the Convex write is readable** → harmless: the settle
  claims nothing, and the row's own staleness gets it swept; in practice the
  command awaits the Convex mutation before nudging.
- **Two DOs for one tenant** → impossible by construction (`idFromName` on the
  tenant key is globally unique).
- **DO + cron-nudge + smoke admin route all firing** → all funnel into the DO's
  alarm (single door). The legacy admin route `/internal/workgraph/reconcile`
  keeps working unchanged for break-glass; it still uses the per-isolate guard.
- **`gh run rerun` downgrade trap** → only rerun deploys on the newest SHA's
  run (see memory: rerunning an older run re-deploys ITS sha).
- **Workers plan limits** → DOs require the paid Workers plan; the account
  already runs paid features (crons, R2). Verify once before U4.

## Execution notes for the implementing agent(s)

- U1, U2, U3 are independent of Cloudflare and can be built and reviewed in
  parallel by separate agents (U3 depends on U2's interface file only — land
  the interface first, then fan out). U4 and U5 can start once U1+U2 merge.
  Prefer a workflow: fan out finders/builders per unit, then one adversarial
  review pass over the combined diff before pushing (regressions must go
  through the composed hosted ROUTER, not store-level tests).
- Never run the repo-wide test suite; use the file lists above (the full
  claxedo-server vitest suite hangs locally).
- Do not edit `packages/claxedo-app/src/features/workgraph/**` — UI is owned by
  the user; this plan is backend-only.
- Any `packages/workspace-runtime/**` change ships via the sandbox image pin
  (`CLAXEDO_SANDBOX_BUILD_ID`) — this plan should not touch it; if it somehow
  does, re-pin before trusting staging results.

## Follow-ups (recorded, not in this plan)
