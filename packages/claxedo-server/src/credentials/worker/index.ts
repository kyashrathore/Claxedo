/**
 * Hosted provider credentials over D1 (`hosted_provider_credentials`,
 * migration 0039).
 *
 * `hostedOrgCredentials(orgId, { database, env })` is the per-org
 * `ControlPlaneCredentials`; it exists only for a request whose org
 * resolution succeeded, and every statement it issues is scoped by `org_id`.
 * The org-agnostic `workerCredentials(env)` that satisfies the
 * `ControlPlaneServices` shape stays fail-closed forever, because a
 * credential without a tenant is exactly the bug org partitioning eliminates.
 *
 * The secret column holds the `cenc1` envelope from
 * `@claxedo/server-core/credentials/envelope` (per-org HKDF subkey, AES-256-GCM
 * bound to the provider id), so the database holds ciphertext only and no
 * path here can write a secret unsealed. Construction requires the KEK: a
 * hosted deployment that cannot encrypt is down, not open.
 *
 * `CLAXEDO_HOSTED_CREDENTIALS_ENABLED=1` turns the surface on. With the flag
 * on, composition fails at construction unless `CLAXEDO_CREDENTIALS_KEK`
 * (optionally `CLAXEDO_CREDENTIALS_KEK_NEXT`) is present and well formed; with
 * it off, every per-org constructor throws and the org-agnostic surface
 * refuses writes.
 *
 * Status transitions are written inside the statements: a health or secret
 * write sets `case when status = 'revoked' then 'revoked' else <verdict> end`,
 * so two workers racing a verification against a revocation cannot reactivate
 * the credential; `updateCredentialStatus` is the only unconditional status
 * write.
 */

import type { ControlPlaneCredentials } from "../../authority/services"
import {
  CREDENTIAL_HEALTHS,
  CREDENTIAL_KINDS,
  CREDENTIAL_SOURCES,
  CREDENTIAL_STATUSES,
  type CredentialKind,
  type CredentialMetadata,
  type CredentialStatus,
  type CredentialWrite,
  type SecretBackend,
} from "@claxedo/server-core/credentials/types"
import {
  encryptedSecretBackend,
  envelopeCipher,
  envelopeKeyProviderFromEnv,
  type EnvelopeAdmin,
} from "@claxedo/server-core/credentials/envelope"
import { trimToUndefined } from "@claxedo/helpers/string"

type WorkerCredentialEnv = Record<string, string | undefined>

/**
 * The D1 surface the store issues statements through. `D1Database` satisfies
 * it inside the Worker; the KEK rotation script satisfies it over Cloudflare's
 * D1 HTTP API from an operator's machine.
 */
export type HostedCredentialDatabase = {
  prepare(query: string): HostedCredentialStatement
}

export type HostedCredentialStatement = {
  bind(...values: unknown[]): HostedCredentialStatement
  first(): Promise<Record<string, unknown> | null>
  all(): Promise<{ results: Record<string, unknown>[] }>
  run(): Promise<{ meta: { changes?: number } }>
}

export type HostedCredentialStoreInput = {
  database: HostedCredentialDatabase
  env: WorkerCredentialEnv
}

const METADATA_COLUMNS =
  "org_id, provider_id, kind, source, label, account_id, status, health, expires_at, last_validated_at, last_error, revision, created_at, updated_at"

/** Default-off feature flag for the hosted credential surface. */
export const HOSTED_CREDENTIALS_FLAG = "CLAXEDO_HOSTED_CREDENTIALS_ENABLED"

export function hostedCredentialsEnabled(env: WorkerCredentialEnv = process.env): boolean {
  return trimToUndefined(env[HOSTED_CREDENTIALS_FLAG]) === "1"
}

export function workerCredentials(env: WorkerCredentialEnv = process.env): ControlPlaneCredentials {
  if (!hostedCredentialsEnabled(env)) {
    const unavailable = (): never => {
      throw new Error("Credential management is not available in the hosted Worker control plane")
    }
    return {
      listCredentials: async () => [],
      getCredentialByProvider: async () => undefined,
      resolveCredentialSecret: async () => null,
      putCredential: async () => unavailable(),
      deleteCredential: async () => unavailable(),
      deleteCredentialsByProvider: async () => unavailable(),
      updateCredentialStatus: async () => unavailable(),
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    }
  }

  // Flag on: prove the KEK is usable at boot, or refuse to start. Throws
  // naming CLAXEDO_CREDENTIALS_KEK when absent or malformed.
  envelopeKeyProviderFromEnv(env)

  const gated = (): never => {
    throw new Error(
      "Hosted credential management is org-partitioned; " +
        "no org-agnostic credential surface exists by design — resolve the caller's org and use hostedOrgCredentials(orgId)",
    )
  }
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async () => undefined,
    resolveCredentialSecret: async () => null,
    putCredential: async () => gated(),
    deleteCredential: async () => gated(),
    deleteCredentialsByProvider: async () => gated(),
    updateCredentialStatus: async () => gated(),
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}

/**
 * The org-partitioned hosted credential surface. One instance serves ONE
 * org; construct it only after the caller's org resolution succeeded, from the
 * verified `org_id` claim, never a client-supplied value.
 *
 * One credential per provider: the metadata id IS the provider id, and
 * `updateCredentialStatus` receives it back.
 */
export function hostedOrgCredentials(
  orgId: string,
  input: HostedCredentialStoreInput,
  opts: { now?: () => number } = {},
): ControlPlaneCredentials {
  if (!hostedCredentialsEnabled(input.env)) {
    throw new Error(`${HOSTED_CREDENTIALS_FLAG} is not enabled — hosted credential access stays fail-closed`)
  }
  const org = orgId?.trim()
  if (!org) {
    throw new Error("hostedOrgCredentials requires a non-empty orgId — org resolution must succeed before any credential access")
  }
  const cipher = envelopeCipher(envelopeKeyProviderFromEnv(input.env), { orgId: org })
  const { database } = input
  const now = opts.now ?? Date.now

  const metadataByProvider = async (providerId: string, kind?: CredentialKind) => {
    const row = await database
      .prepare(
        `select ${METADATA_COLUMNS} from hosted_provider_credentials
         where org_id = ? and provider_id = ?${kind ? " and kind = ?" : ""}`,
      )
      .bind(org, providerId, ...(kind ? [kind] : []))
      .first()
    return row ? credentialMetadataRow(row) : undefined
  }

  const openSecret = async (providerId: string, statusScope: string) => {
    const row = await database
      .prepare(`select secret_envelope from hosted_provider_credentials where org_id = ? and provider_id = ?${statusScope}`)
      .bind(org, providerId)
      .first()
    return row ? cipher.open(providerId, requiredTextColumn(row, "secret_envelope")) : null
  }

  const changed = async (statement: HostedCredentialStatement) => ((await statement.run()).meta.changes ?? 0) > 0

  return {
    listCredentials: async () => {
      const rows = await database
        .prepare(`select ${METADATA_COLUMNS} from hosted_provider_credentials where org_id = ? order by provider_id`)
        .bind(org)
        .all()
      return rows.results.map(credentialMetadataRow)
    },
    getCredentialByProvider: (providerId, kind) => metadataByProvider(providerId, kind),
    getCredential: (id) => metadataByProvider(id),
    // Available-status-only, mirroring credentials/registry.ts resolveSecret;
    // the gate is in the same statement as the read, so a revocation landing
    // between two reads cannot hand out the secret.
    resolveCredentialSecret: (providerId) => openSecret(providerId, " and status = 'available'"),
    // Verification retries must be able to re-check a prior failed result.
    resolveCredentialSecretById: (id) => openSecret(id, ""),
    putCredential: async (input: CredentialWrite) => {
      const timestamp = now()
      const row = await database
        .prepare(
          `insert into hosted_provider_credentials (
             org_id, provider_id, kind, source, label, account_id, status, health,
             expires_at, last_validated_at, last_error, secret_envelope, revision, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, 'available', null, ?, null, null, ?, 1, ?, ?)
           on conflict (org_id, provider_id) do update set
             kind = excluded.kind,
             source = excluded.source,
             label = excluded.label,
             account_id = excluded.account_id,
             status = 'available',
             health = null,
             expires_at = excluded.expires_at,
             last_validated_at = null,
             last_error = null,
             secret_envelope = excluded.secret_envelope,
             revision = hosted_provider_credentials.revision + 1,
             updated_at = excluded.updated_at
           returning ${METADATA_COLUMNS}`,
        )
        .bind(
          org,
          input.provider_id,
          input.kind,
          input.source,
          input.label ?? null,
          input.account_id ?? null,
          input.expires_at ?? null,
          await cipher.seal(input.provider_id, input.secret),
          timestamp,
          timestamp,
        )
        .first()
      if (!row) throw new Error(`hosted credential upsert for "${input.provider_id}" returned no row`)
      return credentialMetadataRow(row)
    },
    deleteCredential: (id) =>
      changed(database.prepare("delete from hosted_provider_credentials where org_id = ? and provider_id = ?").bind(org, id)),
    deleteCredentialsByProvider: async (providerId, kind) => {
      const result = await database
        .prepare(
          `delete from hosted_provider_credentials where org_id = ? and provider_id = ?${kind ? " and kind = ?" : ""}`,
        )
        .bind(org, providerId, ...(kind ? [kind] : []))
        .run()
      return result.meta.changes ?? 0
    },
    updateCredentialStatus: async (id, status, error) => {
      await database
        .prepare(
          `update hosted_provider_credentials
           set status = ?, health = ?, last_error = ?, updated_at = ?
           where org_id = ? and provider_id = ?`,
        )
        .bind(status, status === "expired" ? "expired" : null, error ?? null, now(), org, id)
        .run()
    },
    updateCredentialHealth: async (id, health, validatedAt) => {
      const verdict: CredentialStatus = health === "ok" ? "available" : health === "expired" ? "expired" : "error"
      await database
        .prepare(
          `update hosted_provider_credentials
           set health = ?,
               status = case when status = 'revoked' then 'revoked' else ? end,
               last_validated_at = ?,
               last_error = ?,
               updated_at = ?
           where org_id = ? and provider_id = ?`,
        )
        .bind(health, verdict, validatedAt, health === "ok" ? null : health, now(), org, id)
        .run()
    },
    updateCredentialSecret: async (id, secret, expiresAt) => {
      // `undefined` means the caller does not know the replacement's expiry;
      // `null` means it has none. The stored expiry described the material
      // being replaced, so only the first may carry it over.
      const replaceExpiry = expiresAt === undefined ? 0 : 1
      return changed(
        database
          .prepare(
            `update hosted_provider_credentials
             set secret_envelope = ?,
                 expires_at = case when ? = 1 then ? else expires_at end,
                 health = null,
                 last_validated_at = null,
                 last_error = null,
                 status = case when status = 'revoked' then 'revoked' else 'available' end,
                 revision = revision + 1,
                 updated_at = ?
             where org_id = ? and provider_id = ?`,
          )
          .bind(await cipher.seal(id, secret), replaceExpiry, expiresAt ?? null, now(), org, id),
      )
    },
    // No local credential stores exist on a hosted worker.
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}

/**
 * One org's secret column as a `SecretBackend`, for the KEK rotation sweep
 * (`credentials/operations/rotate.ts`). Refs are `d1:<providerId>`. `put`
 * only ever updates an existing row, so the sweep can re-seal a secret but
 * never mint a credential; `delete` removes the whole row, since the secret has
 * no existence apart from it.
 */
export function hostedCredentialSecretSlots(
  orgId: string,
  input: HostedCredentialStoreInput,
): SecretBackend & EnvelopeAdmin {
  const org = orgId?.trim()
  if (!org) throw new Error("hostedCredentialSecretSlots requires a non-empty orgId")
  const { database } = input
  const column: SecretBackend = {
    async put(id, envelope) {
      await database
        .prepare("update hosted_provider_credentials set secret_envelope = ? where org_id = ? and provider_id = ?")
        .bind(envelope, org, id)
        .run()
      return `d1:${id}`
    },
    async get(ref) {
      const row = await database
        .prepare("select secret_envelope from hosted_provider_credentials where org_id = ? and provider_id = ?")
        .bind(org, providerIdFromSlotRef(ref))
        .first()
      return row ? requiredTextColumn(row, "secret_envelope") : null
    },
    async delete(ref) {
      await database
        .prepare("delete from hosted_provider_credentials where org_id = ? and provider_id = ?")
        .bind(org, providerIdFromSlotRef(ref))
        .run()
    },
    async probe() {
      try {
        await database.prepare("select 1 from hosted_provider_credentials limit 1").all()
        return true
      } catch {
        return false
      }
    },
  }
  return encryptedSecretBackend(column, envelopeKeyProviderFromEnv(input.env), { orgId: org })
}

/** Every slot in the store, across orgs, in the order a rotation sweeps them. */
export async function listHostedCredentialSlots(
  database: HostedCredentialDatabase,
): Promise<Array<{ orgId: string; ref: string }>> {
  const rows = await database
    .prepare("select org_id, provider_id from hosted_provider_credentials order by org_id, provider_id")
    .all()
  return rows.results.map((row) => ({ orgId: requiredTextColumn(row, "org_id"), ref: hostedCredentialSlotRef(requiredTextColumn(row, "provider_id")) }))
}

export function hostedCredentialSlotRef(providerId: string): string {
  return `d1:${providerId}`
}

function providerIdFromSlotRef(ref: string): string {
  if (!ref.startsWith("d1:")) throw new Error(`"${ref}" is not a hosted credential slot ref`)
  return ref.slice("d1:".length)
}

function credentialMetadataRow(row: Record<string, unknown>): CredentialMetadata {
  const providerId = requiredTextColumn(row, "provider_id")
  return {
    id: providerId,
    org_id: requiredTextColumn(row, "org_id"),
    provider_id: providerId,
    kind: enumColumn(row, "kind", CREDENTIAL_KINDS),
    source: enumColumn(row, "source", CREDENTIAL_SOURCES),
    label: nullableTextColumn(row, "label"),
    account_id: nullableTextColumn(row, "account_id"),
    status: enumColumn(row, "status", CREDENTIAL_STATUSES),
    health: column(row, "health") === null ? null : enumColumn(row, "health", CREDENTIAL_HEALTHS),
    expires_at: nullableIntegerColumn(row, "expires_at"),
    last_validated_at: nullableIntegerColumn(row, "last_validated_at"),
    last_error: nullableTextColumn(row, "last_error"),
    created_at: requiredIntegerColumn(row, "created_at"),
    updated_at: requiredIntegerColumn(row, "updated_at"),
    revision: requiredIntegerColumn(row, "revision"),
  }
}

function column(row: Record<string, unknown>, name: string): unknown {
  if (!(name in row)) throw new Error(`hosted credential row has no "${name}" column`)
  return row[name]
}

function requiredTextColumn(row: Record<string, unknown>, name: string): string {
  const value = column(row, name)
  if (typeof value !== "string") throw new Error(`hosted credential column "${name}" is not text`)
  return value
}

function nullableTextColumn(row: Record<string, unknown>, name: string): string | null {
  return column(row, name) === null ? null : requiredTextColumn(row, name)
}

function requiredIntegerColumn(row: Record<string, unknown>, name: string): number {
  const value = column(row, name)
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`hosted credential column "${name}" is not an integer`)
  }
  return value
}

function nullableIntegerColumn(row: Record<string, unknown>, name: string): number | null {
  return column(row, name) === null ? null : requiredIntegerColumn(row, name)
}

function enumColumn<T extends string>(row: Record<string, unknown>, name: string, values: readonly T[]): T {
  const value = requiredTextColumn(row, name)
  if (!enumValue(value, values)) throw new Error(`hosted credential column "${name}" holds a value outside its enum`)
  return value
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return values.some((candidate) => candidate === value)
}
