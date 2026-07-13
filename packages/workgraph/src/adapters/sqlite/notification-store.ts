import type BetterSqlite3 from "better-sqlite3"
import { NotificationVersionConflictError, type NotificationStore } from "../../application/notification-service"
import type { WorkGraphNotification } from "../../contracts"
import { assertNoSqliteWorkGraphOwnerDeletion } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"

export function createSqliteNotificationStore(databaseInput: BetterSqlite3.Database): NotificationStore {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("The SQLite notification adapter requires a real better-sqlite3 database")
  return {
    async list(context, input) {
      const offset = cursor(input.after)
      const rows = database.prepare(`
        SELECT notifications.* FROM wg_v2_notifications notifications WHERE notifications.owner_user_id = ?
          AND (? IS NULL OR notifications.state = ?)
          AND NOT EXISTS (
            SELECT 1 FROM wg_v2_recaps recaps
            WHERE recaps.owner_user_id = notifications.owner_user_id AND recaps.id = notifications.recap_id
              AND (
                json_extract(recaps.generation_result_json, '$.method') = 'deterministic_fallback'
                OR json_extract(recaps.generation_result_json, '$.sessionId') IS NULL
              )
          )
        ORDER BY notifications.created_at DESC, notifications.id DESC LIMIT ? OFFSET ?
      `).all(context.ownerUserId, input.state ?? null, input.state ?? null, input.limit + 1, offset) as NotificationRow[]
      const page = rows.slice(0, input.limit).map(notification)
      return { notifications: page, hasMore: rows.length > input.limit, ...(rows.length > input.limit ? { nextCursor: String(offset + page.length) } : {}) }
    },
    async read(context, id) {
      const row = database.prepare(`
        SELECT notifications.* FROM wg_v2_notifications notifications
        WHERE notifications.owner_user_id = ? AND notifications.id = ?
          AND NOT EXISTS (
            SELECT 1 FROM wg_v2_recaps recaps
            WHERE recaps.owner_user_id = notifications.owner_user_id AND recaps.id = notifications.recap_id
              AND (
                json_extract(recaps.generation_result_json, '$.method') = 'deterministic_fallback'
                OR json_extract(recaps.generation_result_json, '$.sessionId') IS NULL
              )
          )
      `)
        .get(context.ownerUserId, id) as NotificationRow | undefined
      return row ? notification(row) : undefined
    },
    async markRead(context, input) {
      return database.transaction(() => {
        assertNoSqliteWorkGraphOwnerDeletion(database, context.ownerUserId)
        const now = Date.now()
        const changed = database.prepare(`
          UPDATE wg_v2_notifications SET state = 'read', read_at = COALESCE(read_at, ?), updated_at = ?, row_version = row_version + 1
          WHERE owner_user_id = ? AND id = ? AND row_version = ? AND state = 'unread'
            AND NOT EXISTS (
              SELECT 1 FROM wg_v2_recaps recaps
              WHERE recaps.owner_user_id = wg_v2_notifications.owner_user_id AND recaps.id = wg_v2_notifications.recap_id
                AND (
                  json_extract(recaps.generation_result_json, '$.method') = 'deterministic_fallback'
                  OR json_extract(recaps.generation_result_json, '$.sessionId') IS NULL
                )
            )
        `).run(now, now, context.ownerUserId, input.id, input.expectedVersion)
        if (changed.changes !== 1) throw new NotificationVersionConflictError()
        return notification(database.prepare("SELECT * FROM wg_v2_notifications WHERE owner_user_id = ? AND id = ?").get(context.ownerUserId, input.id) as NotificationRow)
      })()
    },
  }
}

function cursor(value?: string) {
  if (!value) return 0
  const result = Number(value)
  if (!Number.isInteger(result) || result < 0) throw new Error("Invalid notification cursor")
  return result
}

function notification(row: NotificationRow): WorkGraphNotification {
  return {
    id: row.id as WorkGraphNotification["id"], ownerUserId: row.owner_user_id as WorkGraphNotification["ownerUserId"], version: row.row_version,
    kind: "actionable_recap", state: row.state as WorkGraphNotification["state"], streamId: row.stream_id as WorkGraphNotification["streamId"],
    recapId: row.recap_id as WorkGraphNotification["recapId"], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.read_at === null ? {} : { readAt: Number(row.read_at) }),
  }
}

type NotificationRow = Readonly<{
  owner_user_id: string; id: string; state: string; stream_id: string; recap_id: string; row_version: number
  created_at: number; updated_at: number; read_at: number | null
}>
