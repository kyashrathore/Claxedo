import { asRecord, asString } from "@claxedo/helpers/guards"
import { authorityRowBacking } from "./cloud-runtime-readiness"
import type { SandboxManagerPort } from "../sandbox/manager-port"

/**
 * Whether a catalog row's runtime can answer now, decided without waking it:
 * a cloud workspace whose sandbox lease is ready, a machine-placed one whose
 * enrollment serves it (`host_online`, the same predicate that routes the
 * relay), or one this server hosts itself.
 */
export function authorityRowReachable(
  row: unknown,
  readyCloud: ReadonlySet<string>,
  servedHere: ReadonlySet<string> = new Set(),
): boolean {
  const record = asRecord(row)
  const workspaceId = asString(record?.workspace_id) ?? asString(record?.workspaceId)
  if (!workspaceId) return false
  if (authorityRowBacking(row) === "cloud-vm") return readyCloud.has(workspaceId)
  return record?.host_online === true || servedHere.has(workspaceId)
}

/** Authority rows as a signed list answers them, each carrying `reachable` from the predicate above. */
export async function withAuthorityRowReachability(
  manager: Pick<SandboxManagerPort, "target"> | undefined,
  rows: readonly unknown[],
) {
  return Promise.all(rows.map(async (row) => {
    const record = asRecord(row)
    if (authorityRowBacking(row) !== "cloud-vm") {
      return { ...record, reachable: authorityRowReachable(row, new Set()) }
    }
    const id = asString(record?.workspace_id) ?? asString(record?.workspaceId)
    if (!id || !manager) return { ...record, reachable: false, status: "failed", error: "Cloud runtime is unavailable" }
    const target = await manager.target(id)
    if (target.status === "ready") return { ...record, reachable: true, status: "ready" }
    if (target.leaseStatus === "acquiring") return { ...record, reachable: false, status: "provisioning" }
    if (target.leaseStatus === "stopped" || target.leaseStatus === "destroyed" || target.reason === "runtime_lease_missing") {
      return { ...record, reachable: false, status: "stopped" }
    }
    return { ...record, reachable: false, status: "failed", error: target.reason }
  }))
}
