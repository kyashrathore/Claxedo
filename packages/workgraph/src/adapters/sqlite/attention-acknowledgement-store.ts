import type BetterSqlite3 from "better-sqlite3"
import type { AttentionAcknowledgementStore } from "../../application/attention-acknowledgement-service"
import type { WorkGraphContext } from "../../contracts"
import { assertNoSqliteWorkGraphOwnerDeletion } from "./deletion-barrier"
import { initializeWorkGraphSqliteSchema } from "./schema"

export function createSqliteAttentionAcknowledgementStore(
  databaseInput: BetterSqlite3.Database,
  clock: Readonly<{ now: () => number }> = { now: () => Date.now() },
): AttentionAcknowledgementStore {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("The SQLite Attention acknowledgement adapter requires a real better-sqlite3 database")

  const acknowledge = (context: WorkGraphContext, clear: boolean) => database.transaction(() => {
    assertNoSqliteWorkGraphOwnerDeletion(database, context.organizationId, context.ownerUserId)
    const now = clock.now()
    database.prepare(`
      INSERT INTO wg_v2_attention_acknowledgements
        (organization_id, owner_user_id, read_through_at, cleared_through_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (organization_id, owner_user_id) DO UPDATE SET
        read_through_at = MAX(wg_v2_attention_acknowledgements.read_through_at, excluded.read_through_at),
        cleared_through_at = CASE
          WHEN excluded.cleared_through_at IS NULL THEN wg_v2_attention_acknowledgements.cleared_through_at
          WHEN wg_v2_attention_acknowledgements.cleared_through_at IS NULL THEN excluded.cleared_through_at
          ELSE MAX(wg_v2_attention_acknowledgements.cleared_through_at, excluded.cleared_through_at)
        END
    `).run(context.organizationId, context.ownerUserId, now, clear ? now : null)
    const row = database.prepare(`
      SELECT read_through_at, cleared_through_at FROM wg_v2_attention_acknowledgements
      WHERE organization_id = ? AND owner_user_id = ?
    `).get(context.organizationId, context.ownerUserId) as { read_through_at: number; cleared_through_at: number | null }
    return {
      ownerUserId: context.ownerUserId,
      readAt: Number(row.read_through_at),
      ...(row.cleared_through_at === null ? {} : { clearedAt: Number(row.cleared_through_at) }),
    }
  })()

  return {
    markAllRead: async (context) => acknowledge(context, false),
    clear: async (context) => acknowledge(context, true),
  }
}
