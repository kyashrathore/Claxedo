import type { SandboxLease } from "@claxedo/sandbox-manager"
import type { SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"

/** Stored row status -> port status. */
export function sandboxLeaseStatus(status: SandboxLeaseRow["status"]): SandboxLease["status"] {
  if (status === "ready") return "ready"
  if (status === "destroyed") return "destroyed"
  if (status === "stopped" || status === "stopping") return "stopped"
  if (status === "pending" || status === "acquiring" || status === "starting") return "acquiring"
  return "unavailable"
}

/**
 * The inverse: port status -> stored row status. The conversion is lossy (the
 * row's ten states collapse to the port's five), so the two directions only
 * round-trip when they are read together, which is why they share a file.
 */
export function sandboxLeaseRowStatus(lease: SandboxLease): SandboxLeaseRow["status"] {
  if (lease.status === "ready" || lease.status === "stopped") return lease.status
  if (lease.status === "unavailable") return lease.nextRetryAt === undefined ? "failed" : "backoff"
  if (lease.status === "destroyed") return "destroyed"
  return "acquiring"
}
