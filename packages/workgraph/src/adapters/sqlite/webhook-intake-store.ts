import { randomUUID } from "node:crypto"
import type BetterSqlite3 from "better-sqlite3"
import type { WebhookIntakeStore } from "../../application/webhook-intake-service"
import type { SourceView } from "../../application/source-view-service"
import { initializeWorkGraphSqliteSchema } from "./schema"

export function createSqliteWebhookIntakeStore(databaseInput: BetterSqlite3.Database): WebhookIntakeStore {
  const database = initializeWorkGraphSqliteSchema(databaseInput).raw()
  if (!database) throw new Error("The SQLite webhook adapter requires a real better-sqlite3 database")

  return {
    async begin(signal) {
      return database.transaction(() => {
        const existing = database.prepare(`
          SELECT status, claim_expires_at FROM wg_v2_webhook_deliveries
          WHERE connection_id = ? AND provider = ? AND delivery_id = ?
        `).get(signal.connectionId, signal.provider, signal.deliveryId) as { status: string; claim_expires_at: number | null } | undefined
        if (existing?.status === "completed") return { state: "completed" as const }
        const now = Date.now()
        if (existing?.status === "pending" && Number(existing.claim_expires_at) > now) return { state: "busy" as const }
        const leaseId = randomUUID()
        if (existing) {
          database.prepare(`
            UPDATE wg_v2_webhook_deliveries
            SET status = 'pending', claimed_by = ?, claim_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
            WHERE connection_id = ? AND provider = ? AND delivery_id = ?
          `).run(leaseId, now + 60_000, now, signal.connectionId, signal.provider, signal.deliveryId)
          return { state: "acquired" as const, leaseId }
        }
        database.prepare(`
          INSERT INTO wg_v2_webhook_deliveries
            (connection_id, provider, delivery_id, event_type, status, claimed_by, claim_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(signal.connectionId, signal.provider, signal.deliveryId, signal.event, leaseId, now + 60_000, now, now)
        return { state: "acquired" as const, leaseId }
      })()
    },
    async listSourceViews(input) {
      return (database.prepare(`
        SELECT * FROM wg_v2_source_views
        WHERE team_connection_id = ? AND provider = ? AND status = 'active'
        ORDER BY updated_at DESC, owner_user_id, id
        LIMIT ?
      `).all(input.connectionId, input.provider, input.limit) as SourceViewRow[]).map(sourceView)
    },
    async complete(signal, leaseId) {
      return database.prepare(`
        UPDATE wg_v2_webhook_deliveries
        SET status = 'completed', claimed_by = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE connection_id = ? AND provider = ? AND delivery_id = ? AND status = 'pending' AND claimed_by = ?
      `).run(Date.now(), signal.connectionId, signal.provider, signal.deliveryId, leaseId).changes === 1
    },
    async fail(signal, leaseId) {
      return database.prepare(`
        UPDATE wg_v2_webhook_deliveries
        SET status = 'failed', claimed_by = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE connection_id = ? AND provider = ? AND delivery_id = ? AND status = 'pending' AND claimed_by = ?
      `).run(Date.now(), signal.connectionId, signal.provider, signal.deliveryId, leaseId).changes === 1
    },
  }
}

function sourceView(row: SourceViewRow): SourceView {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    version: row.row_version,
    teamConnectionId: row.team_connection_id as SourceView["teamConnectionId"],
    provider: row.provider as SourceView["provider"],
    providerUserId: row.provider_user_id,
    filters: JSON.parse(row.filters_json) as Record<string, string>,
    syncPolicy: row.sync_policy as SourceView["syncPolicy"],
    status: row.status as SourceView["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

type SourceViewRow = Readonly<{
  owner_user_id: string
  id: string
  team_connection_id: string
  provider: string
  provider_user_id: string
  filters_json: string
  sync_policy: string
  status: string
  row_version: number
  created_at: number
  updated_at: number
}>
