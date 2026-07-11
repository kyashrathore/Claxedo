// D13 sandbox lease reaper — Convex cron half (launch plan 2026-07-11-012 §1 /
// ADR 016 §4 Decision 3, "scheduled reconciliation loop as the truth-keeper").
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

crons.interval(
  "sweep stale runtime leases",
  { minutes: 10 },
  internal.sandboxLeases.sweepStaleLeases,
  {
    acquiring_stale_after_ms: 15 * 60 * 1000,
    ready_heartbeat_stale_after_ms: 30 * 60 * 1000,
  },
)

export default crons
