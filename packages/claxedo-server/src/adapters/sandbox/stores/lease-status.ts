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
