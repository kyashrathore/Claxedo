import type { D1Database } from "@cloudflare/workers-types"
import type { CloudSessionRowsPublisher } from "@claxedo/server-core/platform/auth/cloud-session-rows"
import { maySql, type BoundSql } from "./authorization"

/** Rechecked inside publication batches and renewal, so replacement ends the producer immediately. */
export function cloudSessionRowsFence(publisher: CloudSessionRowsPublisher): BoundSql {
  const access = maySql(publisher, "operate", { kind: "workspace", alias: "workspace" })
  return {
    sql: `exists (
      select 1 from sandbox_leases lease
      join workspaces workspace on workspace.workspace_id = lease.workspace_id
      where lease.workspace_id = ? and lease.lease_id = ? and lease.epoch = ?
        and lease.status = 'ready' and workspace.backing = 'cloud-vm'
        and workspace.deleted_at is null and workspace.org_id = ? and workspace.project_id = ?
        and workspace.owner_user_id = ?
        and ${access.sql}
    )`,
    bind: [publisher.workspaceId, publisher.hostId, publisher.epoch, publisher.orgId, publisher.projectId, publisher.userId, ...access.bind],
  }
}

export async function cloudSessionRowsPublisherActive(database: D1Database, publisher: CloudSessionRowsPublisher) {
  const fence = cloudSessionRowsFence(publisher)
  return !!await database.prepare(`select 1 where ${fence.sql}`).bind(...fence.bind).first()
}
