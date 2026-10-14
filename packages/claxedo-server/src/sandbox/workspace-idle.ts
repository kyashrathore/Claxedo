/**
 * The one idle policy every cloud sandbox is stopped under. The Cloudflare
 * sandbox Worker bundles this module and applies it from inside the host; the
 * provisioner applies it over the relay for every other driver.
 */

/** How long a runtime reports no work before its sandbox is stopped. */
export const WORKSPACE_IDLE_MS = 600_000
export const IDLE_CHECK_MS = 30_000
/** Ten minutes of checks that all failed: a sandbox no check reaches is stopped rather than metered for a runtime that may be gone. */
export const IDLE_CHECK_FAILURE_LIMIT = 20
/** Longer than any checkpoint holds a runtime frozen: a drain plus the Cloudflare driver's 180 s backup deadline. */
const FROZEN_DEADLINE_MS = 15 * 60_000

/** The runtime's own answer on `GET /api/wr/health`, read as data. */
export type WorkspaceIdleReport = { idleSince?: unknown; frozenSince?: unknown }

/**
 * The `idleBefore` of a stop that is due now — the runtime has been idle for
 * the whole window, or a checkpoint has held it frozen past the deadline — or
 * nothing while it has work.
 */
export function workspaceIdleStopDue(report: WorkspaceIdleReport, now: number, idleMs = WORKSPACE_IDLE_MS): number | undefined {
  const idleBefore = now - idleMs
  const idleDue = typeof report.idleSince === "number" && report.idleSince <= idleBefore
  const frozenDue = typeof report.frozenSince === "number" && report.frozenSince <= now - FROZEN_DEADLINE_MS
  return idleDue || frozenDue ? idleBefore : undefined
}
