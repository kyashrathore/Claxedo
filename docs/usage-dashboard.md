# Unified usage dashboard

Before deploying readers that depend on the expanded Convex usage shape, run
`bunx convex run migrations:run '{"fn":"migrations:backfillLegacyLlmUsage"}'`
for each deployment (`--prod` in production). The component ledger makes the
backfill batched, resumable, and idempotent; do not replace it with a cron or
an ad-hoc sweep.

The Usage dialog answers two different questions without pretending they have
the same scope:

- **Claxedo usage** is the revisioned ledger of turns run through Claxedo. When
  signed in, it includes the tenant's central projection across machines plus
  any still-pending facts on the current machine.
- **Total usage** adds only provider-history events on the current machine that
  can be proven not to belong to a Claxedo session.
- **Quota limits** are provider account windows. They are snapshots, not token
  totals and not billing records.

Estimated API cost is a pricing-catalog projection, not what the provider
billed. Unpriced tokens remain visible as unpriced; unknown token categories
remain unknown and are never filled with zero.

## Runtime and data flow

1. A harness emits `AgentRuntimeEvent.usage` with provider-reported token
   categories, observation semantics, and provider-native session identity.
2. `createTurnMeter()` owns the turn state. It replaces cumulative snapshots,
   adds deltas, ignores observation replays, and writes a higher revision when
   the turn completes, errors, stops, is steered, or is recovered after process
   loss.
3. `SqliteUsageLedger` transactionally stores the immutable revision, updates
   the latest-revision row, and enqueues the accepted revision in the outbox.
4. `createUsageOutboxSync()` keeps unsigned/offline facts pending. After a
   signed identity and central ledger are available, it sends a bounded batch
   and marks every accepted/duplicate/stale acknowledgement delivered. A
   conflict is retained as a conflict for operator inspection. Sync wakes at
   app bootstrap, browser reconnect, terminal turn settlement, dashboard
   open/refresh, and bounded exponential backoff while work remains pending.
   Auth loss explicitly clears the cached identity and invalidates any batch
   that has not reached central ingest. Account switches are serialized, and
   every batch retains the immutable identity captured for that signed request.
5. Central ingest derives the tenant from verified auth, compare-and-sets the
   revision, and updates daily and breakdown rollups. Dashboard reads are
   tenant- and date-indexed; raw facts can be pruned only after their rollup is
   present.
6. On a local deployment, the embedded TokenTracker adapter scans provider
   history without command, queue, upload, telemetry, auth, or device-token
   modules. Classification happens before aggregation:
   - a matching provider-native manifest identity is `claxedo` and excluded;
   - a non-matching identity after that source's persisted coverage boundary is
     `external` and included in Total;
   - missing identity or incomplete provenance is `unclassified`, quarantined,
     and shown as a coverage warning.
7. `LocalUsageRoutes` starts central rollups, current-machine pending revisions,
   classified external history, and quota snapshots concurrently under
   independent deadlines. It composes pricing and the requested breakdown from
   the completed sources. A tenant/range/filter-scoped last central snapshot is
   returned as stale when central refresh fails; hosted routes expose the same
   version-1 contract while declaring local external history unavailable.
8. Account menu → **Usage** opens `UsageDashboard`. Its default is 30 days,
   Tokens, Claxedo, grouped by harness. Range, card, metric, grouping, filter,
   and page changes produce distinct query keys; cached data remains visible
   during a refresh. Tokens and estimated cost use their own daily series, and
   canonical server rows carry exact token categories, cost coverage, status,
   pagination cursors, and safe workspace/session drill-down links.

The authoritative stores are SQLite latest revisions for local truth, Convex
daily rollups for cross-machine truth, and the persisted per-source coverage
boundary for deciding when an unmatched local-history identity may be called
external.

## Local scanner and pricing audit

The server pins `tokentracker-cli@0.75.1`. The audited Bun patch adds one
`scanLocalHistory()` export to TokenTracker's existing parser-only
`src/lib/rollout.js` module. It reads Claude/Pi JSONL, Codex rollouts, Cursor
SDK run stores, and both legacy JSON and current SQLite OpenCode history. The
embedding path imports no TokenTracker Cloud, upload queue, command,
credential, telemetry, or device-identity modules. Its state directory is
supplied by Claxedo. A serialized, gzip-compressed cursor records hashed file
identity, provider/session/model identity, usage counters, and file freshness;
it records neither raw paths nor transcript content. Unchanged files are reused
across 7/30/90-day ranges, changed files are re-read concurrently, and Codex
token events keep their provider timestamp before the public 30-minute
aggregation. Tests use a temporary home and assert the cursor's privacy and
changed-file behavior. A malformed record degrades that source even when other
records in the same file are valid, and categories a provider never emitted
remain `null` through aggregation.

The committed scanner budgets are 35 seconds for a representative 30-day cold
scan, 30 seconds to widen that populated cursor to 90 days, and 5 seconds for a
warm or narrower-range refresh. The route deadline is 40 seconds. On the
release workstation's 8 GB provider history, the measured sequence was
27.5 s cold 30-day, 0.6 s 7-day, 16.3 s widening to 90-day, and 0.8 s warm
30-day. The persisted cursor was compressed rather than retaining the 111 MB
JSON representation. Do not loosen these bounds after a candidate fails;
profile the authoritative parser/cursor path instead.

Pricing uses TokenTracker's versioned catalog through a separate read-only
adapter. Raw facts retain tokens and model identity, so later catalog changes
do not rewrite metering history.

## Operational health and recovery

Only bounded metadata is safe to record:

- pending outbox count and oldest age;
- ingest accepted, duplicate, stale, conflict, and error counts;
- projection latency and requested date range;
- scanner source status and unclassified count;
- priced and unpriced token counts;
- daily-rollup lag.

The server emits `usage.dashboard` for bounded source/latency/coverage state
and `usage.outbox_sync` for accepted, duplicate, stale, conflict, error,
pending, and oldest-age counts. Both use the system identity and exclude tenant
IDs, selected dimensions, provider account identifiers, and transcript data.

Never record prompts, responses, raw filesystem paths, credentials, provider
account IDs, auth headers, TokenTracker device tokens, or transcript bodies.

### Pending outbox growth

1. Confirm the user is signed in and central authority is configured.
2. Check the oldest pending age and the last ingest error.
3. A transient outage requires no repair; refresh or restart retries the same
   immutable revisions.
4. Inspect conflicts separately. Do not mark them delivered or synthesize a
   replacement revision; repair the producer or central canonical row.

### Scanner degradation

1. Identify the failed source from coverage metadata; other sources and
   Claxedo totals remain usable.
2. Confirm the provider history exists and the pinned TokenTracker contract
   test passes.
3. Do not classify events before the persisted source boundary as external.
4. Do not bypass missing native identity. Those rows must remain quarantined.

### Unpriced-model spikes

1. Compare the model IDs in the model breakdown with catalog `0.75.1`.
2. Update the pricing catalog/adapter independently of stored facts.
3. Keep the UI's unpriced count visible until the catalog recognizes the model.

### Rollup lag or retention trouble

1. Check the daily projection update time and the retention cron result.
2. Verify the fact has `usage_rolled_up_at` before allowing pruning.
3. Replay the immutable revision if needed; compare-and-set makes an identical
   replay a duplicate and a changed same-revision payload a conflict.

## Release gates

Run these from the repository root unless a package is shown:

```sh
bun --cwd packages/agent-event-runtime run test
bun --cwd packages/agent-event-runtime run typecheck
bun --cwd packages/agent-sdk-runtime run test
bun --cwd packages/agent-sdk-runtime run typecheck
bun --cwd packages/claxedo-server run test
bun --cwd packages/claxedo-server run typecheck
bun --cwd packages/claxedo-server run smoke:usage
bun --cwd packages/claxedo-app run typecheck
bun --cwd packages/claxedo-app run test:e2e:usage
CLAXEDO_TIER_REAL_E2E=1 bun --cwd packages/claxedo-app run test:e2e:real
```

`smoke:usage` is credential-free and release-blocking. Its first half covers
every harness identifier with exact provider token fixtures, revision replay,
overlap, offline convergence, the privacy boundary, and fixed 7/30/90-day
projection budgets of 40/80/180 ms over 10,800 facts. Its second half runs the
real outbox → Convex adapter → authenticated service mutation → daily/exact
projection chain. That chain proves a Machine A upload is visible to Machine B,
another tenant sees zero rows, an invalid service credential is rejected,
request payloads contain no transcript/path/auth content, error settlements
project correctly, and 400-day raw-fact pruning leaves rollups unchanged.

The Tier R journey is also credential-free but requires the real optional
harness binaries; it points them at a scripted provider endpoint and asserts
that each supported executable harness settles three exact usage facts. Tests
against real provider endpoints remain opt-in because they consume provider
quota and are not a release gate.

## Capability and failure semantics

- Hosted web marks current-machine external history unavailable; it does not
  fake a Total from unavailable local data.
- Central failure leaves local and pending Claxedo usage visible as stale.
- Scanner failure degrades only external history.
- Quota failure degrades only provider windows.
- Pricing failure or an unknown model never removes tokens.
- An invalid revision, tenant-crossing request, or unsigned central query is
  rejected at the server boundary.
