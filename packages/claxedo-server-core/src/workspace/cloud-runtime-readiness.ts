import { asRecord, asString } from "@claxedo/helpers/guards"
import type { SandboxManagerPort } from "../sandbox/manager-port"

export type AuthorityRowBacking = "local-worktree" | "cloud-vm"

/**
 * A row naming no backing is the provisioner's, never the reader's own
 * machine: defaulting the other way would put somebody else's workspace on
 * this one.
 */
export function authorityRowBacking(row: unknown): AuthorityRowBacking {
  return asString(asRecord(row)?.backing) === "local-worktree" ? "local-worktree" : "cloud-vm"
}

function cloudWorkspaceIds(rows: readonly unknown[]) {
  return rows.flatMap((row) => {
    const record = asRecord(row)
    const id = asString(record?.workspace_id) ?? asString(record?.workspaceId)
    return id && authorityRowBacking(row) === "cloud-vm" ? [id] : []
  })
}

/**
 * The cloud workspaces among authority rows whose sandbox is running now.
 * `target` reads the lease row alone, so asking never starts compute; a
 * deployment with no sandbox manager runs no sandbox at all.
 */
export async function readyCloudWorkspaces(
  manager: Pick<SandboxManagerPort, "target"> | undefined,
  rows: readonly unknown[],
): Promise<ReadonlySet<string>> {
  if (!manager) return new Set()
  const targets = await Promise.all(
    cloudWorkspaceIds(rows).map(async (id) => [id, (await manager.target(id)).status] as const),
  )
  return new Set(targets.flatMap(([id, status]) => (status === "ready" ? [id] : [])))
}
