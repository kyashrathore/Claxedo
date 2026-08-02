/**
 * Host adapters: implement @claxedo/connections store ports over the claxedo
 * credential registry and connection table. Owner values remain opaque here;
 * identity and authorization belong to connections-host.ts.
 */
import { and, eq, isNull } from "drizzle-orm"
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
  const credentialFor = async (providerId: string) => {
    const current = await credentials.getCredentialByProvider(providerId)
    if (current) return { credential: current, providerId }
  }

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
      const result = await credentialFor(providerId)
      const meta = result?.credential
      if (!meta || (meta.kind !== "api_key" && meta.kind !== "oauth_token")) return undefined
      return {
        kind: meta.kind,
        status: meta.status,
        ...(meta.expires_at !== null && meta.expires_at !== undefined ? { expiresAt: meta.expires_at } : {}),
      }
    },
    async resolveSecret(providerId) {
      if (!credentials.resolveCredentialSecret) throw new ConnectionsUnavailableError()
      const result = await credentialFor(providerId)
      if (!result) return null
      return credentials.resolveCredentialSecret(result.providerId)
    },
    async readSecret(providerId) {
      if (!credentials.resolveCredentialSecret) throw new ConnectionsUnavailableError()
      const result = await credentialFor(providerId)
      if (!result) return null
      if (result.credential.status !== "available") await credentials.updateCredentialStatus(result.credential.id, "available")
      return credentials.resolveCredentialSecret(result.providerId)
    },
    async setStatus(providerId, status, lastError) {
      const result = await credentialFor(providerId)
      if (!result) return
      await credentials.updateCredentialStatus(result.credential.id, status, lastError)
    },
    async deleteByProvider(providerId) {
      await credentials.deleteCredentialsByProvider(providerId)
    },
  }
}

type ConnectionRowRecord = typeof ClaxedoConnectionTable.$inferSelect

function toRow(record: ConnectionRowRecord): ConnectionRow {
  return {
    id: record.id,
    integrationId: record.integration_id,
    ...(record.owner !== null ? { owner: record.owner } : {}),
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
        ClaxedoDB.use((db) => db.update(ClaxedoConnectionTable).set({ ...values, id: existing.id }).where(eq(ClaxedoConnectionTable.id, existing.id)).run())
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
