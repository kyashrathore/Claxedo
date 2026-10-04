import type { D1Database } from "@cloudflare/workers-types"

type WorkspaceDeletion = { ownerUserId: string; workspaceId: string }

/**
 * The statements that delete an owner's workspace, for a caller that runs them
 * under its own authorization guard. The batch assertion proves this batch is
 * the one that deleted it.
 */
export function workspaceDeletionStatements(database: D1Database, row: WorkspaceDeletion & { assertionId: string; now: number }) {
  return [
    database
      .prepare(`
        update workspaces set deleted_at = ?, updated_at = ?
        where workspace_id = ? and deleted_at is null and owner_user_id = ?
      `)
      .bind(row.now, row.now, row.workspaceId, row.ownerUserId),
    database
      .prepare(`
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from workspaces where workspace_id = ? and owner_user_id = ? and deleted_at = ?
        ) then 1 else 0 end)
      `)
      .bind(row.assertionId, row.workspaceId, row.ownerUserId, row.now),
    database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(row.assertionId),
  ]
}

export async function workspaceDeletedBy(database: D1Database, row: WorkspaceDeletion): Promise<boolean> {
  return !!(await database
    .prepare(`select 1 from workspaces where workspace_id = ? and owner_user_id = ? and deleted_at is not null`)
    .bind(row.workspaceId, row.ownerUserId)
    .first())
}
