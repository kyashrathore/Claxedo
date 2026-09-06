import type { SandboxLease } from "@claxedo/sandbox-manager"
import type { SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"

/**
 * The ONE stored-row-status -> port-status conversion.
 *
 * Extracted because `stores/sqlite.ts` and `stores/sqlite-supervisor-state.ts`
 * each carried a hand-maintained copy, and they had drifted apart on
 * `"stopping"`: one fell through to `"acquiring"` (lease coming UP), the other
 * returned `"stopped"` (lease going DOWN) — opposite meanings for one row.
 * No writer emits `"stopping"` today so the divergence never fired in
 * production; it is exactly the shape of bug two copies produce.
 *
 * Lives in its own module rather than in either store because
 * sqlite-supervisor-state.ts already imports sqlite.ts, so putting it in
 * either would close an import cycle.
 */
export function sandboxLeaseStatus(status: SandboxLeaseRow["status"]): SandboxLease["status"] {
  if (status === "ready") return "ready"
  if (status === "destroyed") return "destroyed"
  if (status === "stopped" || status === "stopping") return "stopped"
  if (status === "pending" || status === "acquiring" || status === "starting") return "acquiring"
  return "unavailable"
}

/**
 * The inverse: port status -> stored row status. Both stores wrote their own
 * copy, and `stores/d1.ts` carried a comment promising its copy was kept
 * "byte-identical" to `stores/sqlite.ts`'s — a promise no check enforced.
 * The conversion is lossy (the row's ten states collapse to the port's five),
 * so the two directions only round-trip when they are read together, which is
 * the reason they now sit in one file.
 */
export function sandboxLeaseRowStatus(lease: SandboxLease): SandboxLeaseRow["status"] {
  if (lease.status === "ready" || lease.status === "stopped") return lease.status
  if (lease.status === "unavailable") return lease.nextRetryAt === undefined ? "failed" : "backoff"
  if (lease.status === "destroyed") return "destroyed"
  return "acquiring"
}
