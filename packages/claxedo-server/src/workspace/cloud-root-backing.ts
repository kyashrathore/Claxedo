import type { D1Database } from "@cloudflare/workers-types"

/**
 * A workspace with no live row, such as one deleted while a connection was
 * preparing it, is refused: answering it as a non-cloud root would boot the
 * root with no tool-group consent and no plugin projection.
 */
export class HostedRuntimeNotReadyError extends Error {
  readonly code = "workspace_runtime_not_ready"
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} has no live workspace row; its root cannot be prepared`)
    this.name = "HostedRuntimeNotReadyError"
  }
}

async function recordedBacking(database: D1Database, workspaceId: string): Promise<string | undefined> {
  const row = await database
    .prepare("select backing from workspaces where workspace_id = ? and deleted_at is null")
    .bind(workspaceId)
    .first<{ backing: string }>()
  return row?.backing
}

export async function isCloudRoot(database: D1Database, workspaceId: string): Promise<boolean> {
  return await recordedBacking(database, workspaceId) === "cloud-vm"
}

export async function cloudRootBacking(database: D1Database, workspaceId: string): Promise<"cloud" | "elsewhere"> {
  const backing = await recordedBacking(database, workspaceId)
  if (backing === undefined) throw new HostedRuntimeNotReadyError(workspaceId)
  return backing === "cloud-vm" ? "cloud" : "elsewhere"
}

/** The private repository a cloud root clones and the connection it was created through; absent when anyone can clone it. */
export async function cloudRootPrivateRepository(database: D1Database, workspaceId: string) {
  const row = await database
    .prepare("select repo_url, repo_connection_id from workspaces where workspace_id = ? and deleted_at is null")
    .bind(workspaceId)
    .first<{ repo_url: string | null; repo_connection_id: string | null }>()
  return row?.repo_url && row.repo_connection_id ? { repoUrl: row.repo_url, connectionId: row.repo_connection_id } : undefined
}
