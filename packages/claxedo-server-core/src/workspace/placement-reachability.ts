import { asRecord, asString } from "@claxedo/helpers/guards"
import { authorityRowBacking } from "./cloud-runtime-readiness"

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
