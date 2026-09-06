/**
 * The SQLite `ConnectionStorePort`: connection metadata over the claxedo
 * connection table. Owner values remain opaque here; identity and
 * authorization belong to connections-host.ts, and credential material belongs
 * to `credential-store-adapter.ts`.
 */
import { and, eq, isNull } from "drizzle-orm"
import {
  ConnectionExistsError,
  type ConnectionRow,
  type ConnectionStorePort,
} from "@claxedo/connections"
import { ClaxedoDB } from "../platform/db"
import { ClaxedoConnectionTable } from "./connection.sql"
import { storedCapabilities, storedFields } from "./stored-columns"

type ConnectionRowRecord = typeof ClaxedoConnectionTable.$inferSelect

function toRow(record: ConnectionRowRecord): ConnectionRow {
  return {
    id: record.id,
    integrationId: record.integration_id,
    ...(record.owner !== null ? { owner: record.owner } : {}),
    ...(record.account_label !== null ? { accountLabel: record.account_label } : {}),
    grantedCapabilities: storedCapabilities(record.granted_capabilities),
    fields: storedFields(record.fields),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

export function createConnectionStoreAdapter(): ConnectionStorePort {
  return {
    async upsert(row) {
      const values = {
        id: row.id,
        integration_id: row.integrationId,
        owner: row.owner ?? null,
        account_label: row.accountLabel ?? null,
        granted_capabilities: JSON.stringify(row.grantedCapabilities),
        fields: JSON.stringify(row.fields),
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }
      const existing = await this.get(row.integrationId, row.owner)
      if (existing) {
        // The supplied id is the key, so a DIFFERENT id for a partition that
        // already holds this integration is refused rather than written under
        // the old id: overwriting kept the row readable but stranded the
        // credential the caller had just stored under the id it supplied.
        if (existing.id !== row.id) throw new ConnectionExistsError()
        ClaxedoDB.use((db) => db.update(ClaxedoConnectionTable).set(values).where(eq(ClaxedoConnectionTable.id, row.id)).run())
        return
      }
      ClaxedoDB.use((db) => db.insert(ClaxedoConnectionTable).values(values).run())
    },
    async get(integrationId, owner) {
      const record = ClaxedoDB.use((db) =>
        db
          .select()
          .from(ClaxedoConnectionTable)
          .where(and(
            eq(ClaxedoConnectionTable.integration_id, integrationId),
            owner === undefined ? isNull(ClaxedoConnectionTable.owner) : eq(ClaxedoConnectionTable.owner, owner),
          ))
          .get(),
      )
      return record ? toRow(record) : undefined
    },
    async getById(id) {
      const record = ClaxedoDB.use((db) =>
        db.select().from(ClaxedoConnectionTable).where(eq(ClaxedoConnectionTable.id, id)).get(),
      )
      return record ? toRow(record) : undefined
    },
    async list(filter) {
      const records = ClaxedoDB.use((db) => {
        if (filter?.owner === undefined) return db.select().from(ClaxedoConnectionTable).all()
        if (filter.owner === null) return db.select().from(ClaxedoConnectionTable).where(isNull(ClaxedoConnectionTable.owner)).all()
        return db.select().from(ClaxedoConnectionTable).where(eq(ClaxedoConnectionTable.owner, filter.owner)).all()
      })
      return records.map(toRow)
    },
    async delete(id) {
      const existing = await this.getById(id)
      if (!existing) return false
      ClaxedoDB.use((db) => db.delete(ClaxedoConnectionTable).where(eq(ClaxedoConnectionTable.id, id)).run())
      return true
    },
  }
}
