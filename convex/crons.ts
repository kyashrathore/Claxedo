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

export default crons
