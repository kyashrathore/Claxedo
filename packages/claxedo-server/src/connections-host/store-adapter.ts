/**
 * Host adapters: implement @claxedo/connections store ports over
 * claxedo-server's credential registry (via the ControlPlaneCredentials
 * port) and the claxedo_connection drizzle table. The package stays
 * decision-free; everything claxedo-specific lives here.
 */
import { eq } from "drizzle-orm"
import {
  ConnectionsUnavailableError,
  type ConnectionRow,
  type ConnectionStorePort,
  type CredentialStorePort,
  type IntegrationCapability,
} from "@claxedo/connections"
import type { ControlPlaneCredentials } from "../control-plane/services"
import { ClaxedoDB } from "../storage/db"
import { ClaxedoConnectionTable } from "../storage/connection.sql"

export function createCredentialStoreAdapter(credentials: ControlPlaneCredentials): CredentialStorePort {
  return {
    async put(input) {
      await credentials.putCredential({
        provider_id: input.providerId,
        kind: input.kind,
        source: "managed",
        secret: input.secret,
        ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
      })
    },
    async get(providerId) {
      const meta = await credentials.getCredentialByProvider(providerId)
      if (!meta || (meta.kind !== "api_key" && meta.kind !== "oauth_token")) return undefined
      return {
        kind: meta.kind,
        status: meta.status,
        ...(meta.expires_at !== null && meta.expires_at !== undefined ? { expiresAt: meta.expires_at } : {}),
      }
    },
    async resolveSecret(providerId) {
      if (!credentials.resolveCredentialSecret) throw new ConnectionsUnavailableError()
      return await credentials.resolveCredentialSecret(providerId)
    },
    async readSecret(providerId) {
      // The registry's secret read is available-status-only. Re-verify needs
      // the stored secret regardless of status, so restore "available" first
      // and let the caller's verify outcome set the final status. Single
      // user-initiated flow on a single-process server: the window is
      // microseconds and re-verify immediately overwrites the status.
      if (!credentials.resolveCredentialSecret) throw new ConnectionsUnavailableError()
      const meta = await credentials.getCredentialByProvider(providerId)
      if (!meta) return null
      if (meta.status !== "available") await credentials.updateCredentialStatus(meta.id, "available")
      return await credentials.resolveCredentialSecret(providerId)
    },
    async setStatus(providerId, status, lastError) {
      const meta = await credentials.getCredentialByProvider(providerId)
      if (!meta) return
      await credentials.updateCredentialStatus(meta.id, status, lastError)
    },
    async deleteByProvider(providerId) {
      await credentials.deleteCredentialsByProvider(providerId)
    },
  }
}

type ConnectionRowRecord = typeof ClaxedoConnectionTable.$inferSelect

function toRow(record: ConnectionRowRecord): ConnectionRow {
  return {
    integrationId: record.integration_id,
    ...(record.account_label !== null ? { accountLabel: record.account_label } : {}),
    grantedCapabilities: JSON.parse(record.granted_capabilities) as IntegrationCapability[],
    fields: JSON.parse(record.fields) as Record<string, string>,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

export function createConnectionStoreAdapter(): ConnectionStorePort {
  return {
    async upsert(row) {
      const values = {
        integration_id: row.integrationId,
        account_label: row.accountLabel ?? null,
        granted_capabilities: JSON.stringify(row.grantedCapabilities),
        fields: JSON.stringify(row.fields),
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      }
      ClaxedoDB.use((db) =>
        db
          .insert(ClaxedoConnectionTable)
          .values(values)
          .onConflictDoUpdate({ target: ClaxedoConnectionTable.integration_id, set: values })
          .run(),
      )
    },
    async get(integrationId) {
      const record = ClaxedoDB.use((db) =>
        db.select().from(ClaxedoConnectionTable).where(eq(ClaxedoConnectionTable.integration_id, integrationId)).get(),
      )
      return record ? toRow(record) : undefined
    },
    async list() {
      const records = ClaxedoDB.use((db) => db.select().from(ClaxedoConnectionTable).all())
      return records.map(toRow)
    },
    async delete(integrationId) {
      const existing = ClaxedoDB.use((db) =>
        db.select().from(ClaxedoConnectionTable).where(eq(ClaxedoConnectionTable.integration_id, integrationId)).get(),
      )
      if (!existing) return false
      ClaxedoDB.use((db) =>
        db.delete(ClaxedoConnectionTable).where(eq(ClaxedoConnectionTable.integration_id, integrationId)).run(),
      )
      return true
    },
  }
}
