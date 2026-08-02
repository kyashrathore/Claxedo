// D13 sandbox lease reaper — Convex cron half (ADR 016 §4 Decision 3,
// "scheduled reconciliation loop as the truth-keeper").
//
// This cron keeps the lease TABLE honest (mark dead in-flight acquires
// unavailable, mark heartbeat-silent ready leases stopped). The driver-side
// half — listing driver resources and destroying orphans — runs in the
// control-plane Worker (`sandboxManager.garbageCollect()`), driven by the
// Cloudflare Cron Trigger in packages/claxedo-server/wrangler.toml, because
// driver credentials never enter Convex.
//
// Grace periods are deliberately generous multiples of the live cadences so
// the reaper can never kill in-flight work:
// - acquiring: manager stale-steal is 60s and cold starts finish well inside
//   minutes; 15 minutes of zero progress is unambiguously a dead provision.
// - ready heartbeat: runtimes heartbeat on the order of seconds-to-a-minute
//   and the idle policy stops at 10 minutes; 30 minutes of silence means the
//   lease is lying (runtime dead or provider auto-stopped) — Daytona
//   autoStop (ADR layer 1) has long since bounded the money by then.
import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

crons.interval("sweep stale runtime leases", { minutes: 10 }, internal.sandboxLeases.sweepStaleLeases, {
  acquiring_stale_after_ms: 15 * 60 * 1000,
  ready_heartbeat_stale_after_ms: 30 * 60 * 1000,
})

// D5 billing reconciliation sweep, Convex half (ADR 014
// §3): Polar disables a webhook endpoint after 10 consecutive failed
// deliveries, so mirror-via-webhook needs a truth-keeper. This cron FLAGS
// orgs whose billing mirror has not been touched for 24h; the Worker's Cron
// Trigger (src/worker.ts `scheduled` → src/billing/reconcile.ts) fetches
// fresh customer state from Polar for flagged orgs and re-applies it via
// billing.applyPolarState (which clears the flag). Polar credentials never
// enter Convex — the split mirrors the D13 reaper. Failure to REACH Polar
// never downgrades anyone: only a successfully fetched fresh state writes.
crons.interval("flag stale billing sync", { hours: 6 }, internal.billing.flagStaleBillingSync, {
  stale_after_ms: 24 * 60 * 60 * 1000,
})

// W5 sandbox-compute rollup (metric spec §4.2). Closed lease intervals land in
// `sandbox_lease_events` one row at a time; this folds them into the daily
// per-tenant buckets that answer "how much sandbox compute does my average
// user consume?". Hourly rather than daily so a day's number is readable while
// the day is still running, and the sweep is consume-once
// (`rolled_up_at`-stamped) so the cadence can change freely without
// double-counting. The batch bound keeps one tick inside a single Convex
// transaction; a backlog drains over the following ticks.
crons.interval("roll up sandbox usage", { hours: 1 }, internal.usageMetering.rollupSandboxUsageDaily, {
  limit: 1000,
})

// W5 retention (plan D3). One row per lease and per turn is unbounded growth at
// Cloud scale — `audit_events` has no retention cron and neither would these.
// Raw facts age out at 400 days; the daily rollups are kept, so the long-range
// answer survives the prune. Lease facts are only prunable once rolled up, so
// this can never erase compute the daily table has not yet counted.
crons.interval("prune usage facts", { hours: 24 }, internal.usageMetering.pruneUsageFacts, {
  retain_ms: 400 * 24 * 60 * 60 * 1000,
  limit: 1000,
})

// §6.12 organization deletion cascade. `organization.deleted` records a purge
// REQUEST (`orgs.purge_requested_at`); this is what actually destroys the rows,
// once the retention grace window has elapsed. During that week an org
// re-created in Clerk clears its own request and is never touched.
//
// Deliberately NOT wired to the webhook itself: a Svix delivery is not the
// place to start an irreversible multi-transaction purge, and an hour of delay
// costs nothing against a seven-day window. One org per tick, several bounded
// batches per org — see `orgs.purgeDeletedOrgs` for why both limits exist.
// CLI session token retention. Every `claxedo login` writes two rows and every
// refresh writes two more, so without a reaper the registry only ever grows.
// An expired row is inert — the JWT it describes fails signature verification
// before the registry is consulted — so pruning cannot resurrect a credential;
// the 24h retention is a clock-skew cushion, not a safety property. Hourly with
// a bounded batch keeps each sweep inside one transaction.
crons.interval("reap expired CLI session tokens", { hours: 1 }, internal.cliSessionTokens.reapExpired, {
  retain_ms: 24 * 60 * 60 * 1000,
  limit: 1000,
})

crons.interval("purge deleted organizations", { hours: 1 }, internal.orgs.purgeDeletedOrgs, {
  retain_ms: 7 * 24 * 60 * 60 * 1000,
  batch_limit: 256,
})

// ── W6.3 Clerk membership drift (cf-reliability review W6.3) ──
//
// Org memberships arrive by Clerk webhook and by nothing else, and the runtime
// authz path treats the resulting Convex row as the SOLE authority (JWT org
// claims are deliberately untrusted, D2). So a dropped
// `organizationMembership.deleted` is not stale data — it is a removed employee
// keeping org-admin access on every workspace in that org, indefinitely, with no
// expiry to save us. Same class of problem as billing's D5 sweep (Svix disables
// an endpoint after 5 days of failed deliveries, silently stopping every event),
// hence the same shape: a scheduled truth-keeper.
//
// DAILY, not hourly. Clerk's Backend API budget is shared with live product
// traffic — sign-ins are rate-limited against the same per-instance quota — so
// the sweep's cadence is chosen to leave that quota alone, not to minimize
// detection latency. `CLERK_SWEEP_ORG_CAP` orgs per run, round-robined via
// `clerk_sync_state.sweep_cursor`, so coverage is complete over successive runs.
//
// UNLIKE the D13 reaper and the D5 billing sweep, this runs ENTIRELY in Convex:
// it is an ACTION holding `CLERK_SECRET_KEY`, because queries and mutations
// cannot `fetch`. See the header of convex/clerkReconcile.ts for why Clerk
// credentials are deployment-resident here while Polar/Daytona credentials are
// deliberately not.
//
// OPERATOR STEP: this cron is inert until `CLERK_SECRET_KEY` is set on the
// Convex deployment. The action throws without it, so the failure is loud
// (a red cron invocation) rather than a sweep that silently corrects nothing.
crons.interval("reconcile Clerk memberships", { hours: 24 }, internal.clerkReconcile.sweepClerkMemberships, {})

// Tombstone retention. One row per revoked membership, so without a reaper this
// table only grows. Retention is measured from when the tombstone was written
// because what it must outlast is the webhook REDELIVERY window (~27.5h of Svix
// retries, up to 5 days before an endpoint is disabled); 30 days clears that
// envelope with room to spare. Bounded batch keeps one sweep in one transaction.
crons.interval("reap Clerk membership tombstones", { hours: 24 }, internal.clerkReconcile.reapMembershipTombstones, {
  retain_ms: 30 * 24 * 60 * 60 * 1000,
  limit: 1000,
})

// Webhook liveness — the `flagStaleBillingSync` analogue. Deployment-wide
// ("no Clerk webhook of ANY type in 24h despite live Clerk orgs") rather than
// per-org, because Clerk only emits on actual membership change: a per-org
// staleness clock would flag every org with a stable roster. The flag
// self-clears on the next webhook of any type. 6h matches the billing sweep's
// cadence — the same reason applies, a detector should notice well inside the
// window it measures.
crons.interval("flag stale Clerk webhooks", { hours: 6 }, internal.clerkReconcile.flagStaleClerkWebhooks, {
  stale_after_ms: 24 * 60 * 60 * 1000,
})

// W4.2/W4.3 durable idempotency GC. Rows are self-expiring by design (a
// completed receipt is replayable for 5 minutes, an in-flight claim holds for
// 60 seconds), so this sweep only reclaims storage — correctness never depends
// on it having run, which is why the cadence is loose.
//
// Every 15 minutes rather than every minute: at 5-minute TTLs a tick collects
// at most a few minutes of accumulated rows, and the sweep is bounded per tick
// (`IDEMPOTENCY_SWEEP_LIMIT`) and level-triggered, so a backlog drains across
// ticks instead of pushing one transaction toward Convex's read cap.
crons.interval("sweep expired control-plane idempotency rows", { minutes: 15 }, internal.idempotency.sweepExpired, {
  limit: 500,
})

export default crons
