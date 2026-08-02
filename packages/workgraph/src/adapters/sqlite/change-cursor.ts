import type BetterSqlite3 from "better-sqlite3"
import type { WorkGraphContext } from "../../contracts"

export function allocateSqliteChangeCursor(
  database: BetterSqlite3.Database,
  context: WorkGraphContext,
  occurredAt: number,
) {
  database
    .prepare(`
      INSERT OR IGNORE INTO wg_v2_change_cursors
        (organization_id, owner_user_id, next_cursor, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `)
    .run(context.organizationId, context.ownerUserId, occurredAt, occurredAt)
  const row = database
    .prepare("SELECT next_cursor FROM wg_v2_change_cursors WHERE organization_id = ? AND owner_user_id = ?")
    .get(context.organizationId, context.ownerUserId) as { next_cursor: number }
  database
    .prepare(`
      UPDATE wg_v2_change_cursors
      SET next_cursor = next_cursor + 1, row_version = row_version + 1, updated_at = ?
      WHERE organization_id = ? AND owner_user_id = ?
    `)
    .run(occurredAt, context.organizationId, context.ownerUserId)
  return row.next_cursor
}
