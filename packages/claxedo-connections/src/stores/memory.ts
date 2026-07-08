// In-memory port implementations for tests and examples. Not durable.
import type {
  ConnectionRow,
  ConnectionStorePort,
  CredentialRecord,
  CredentialStorePort,
  CredentialStatus,
} from "../types.js"

type MemoryCredential = CredentialRecord & { secret: string; lastError?: string }

export function createMemoryCredentialStore(): CredentialStorePort & {
  inspect(providerId: string): (CredentialRecord & { lastError?: string }) | undefined
} {
  const rows = new Map<string, MemoryCredential>()
  return {
    async put(input) {
      rows.set(input.providerId, {
        kind: input.kind,
        status: "available",
        secret: input.secret,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      })
    },
    async get(providerId) {
      const row = rows.get(providerId)
      if (!row) return undefined
      const { secret: _secret, lastError: _lastError, ...record } = row
      return record
    },
    async resolveSecret(providerId) {
      const row = rows.get(providerId)
      return row && row.status === "available" ? row.secret : null
    },
    async readSecret(providerId) {
      return rows.get(providerId)?.secret ?? null
    },
    async setStatus(providerId, status: Extract<CredentialStatus, "available" | "error">, lastError) {
      const row = rows.get(providerId)
      if (!row) return
      row.status = status
      if (status === "available") delete row.lastError
      else if (lastError) row.lastError = lastError
    },
    async deleteByProvider(providerId) {
      rows.delete(providerId)
    },
    inspect(providerId) {
      const row = rows.get(providerId)
      if (!row) return undefined
      const { secret: _secret, ...rest } = row
      return rest
    },
  }
}

export function createMemoryConnectionStore(): ConnectionStorePort {
  const rows = new Map<string, ConnectionRow>()
  return {
    async upsert(row) {
      rows.set(row.integrationId, { ...row })
    },
    async get(integrationId) {
      const row = rows.get(integrationId)
      return row ? { ...row } : undefined
    },
    async list() {
      return [...rows.values()].map((row) => ({ ...row }))
    },
    async delete(integrationId) {
      return rows.delete(integrationId)
    },
  }
}
