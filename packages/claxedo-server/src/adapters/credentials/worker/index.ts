/**
 * Worker-safe credentials.
 *
 * The hosted Worker control plane's first surface (health, JWKS, status,
 * device-login, workspace connection/register/heartbeat/pause,
 * relay resolver) does NOT manage provider credentials, so this stays
 * fail-closed by default. It exists to satisfy the `ControlPlaneServices`
 * shape without importing `credentials/store.ts` or `credentials/registry.ts`,
 * which statically pull in the local encrypted file backend (`fs`).
 *
 * D10: the
 * hosted credential byte path is envelope-encrypted Cloudflare KV —
 * `createHostedOrgSecretBackend(orgId)` composes the mandatory encryption
 * wrapper (per-org HKDF subkeys, key-id-prefixed AES-256-GCM, Web Crypto
 * only) over the KV byte store. The raw KV backend is not exported anywhere,
 * so no future call site can reach KV unencrypted.
 *
 * Enabling is gated behind CLAXEDO_HOSTED_CREDENTIALS_ENABLED=1 (default
 * OFF). With the flag on, composition FAILS CLOSED AT CONSTRUCTION TIME
 * unless the envelope KEK (CLAXEDO_CREDENTIALS_KEK, optional
 * CLAXEDO_CREDENTIALS_KEK_NEXT rotation slot) and the KV config
 * (CLAXEDO_CF_KV_URL / CLAXEDO_CF_KV_TOKEN) are all present — a hosted
 * deployment that cannot encrypt must be down, not open.
 *
 * D7: the org-partitioned credential surface is
 * `hostedOrgCredentials(orgId, env)` — a per-org `ControlPlaneCredentials`
 * composed over `createHostedOrgSecretBackend(orgId)`. It exists ONLY for a
 * request whose org resolution succeeded (the caller passes the verified
 * orgId); the org-AGNOSTIC `workerCredentials` surface stays fail-closed
 * forever, because a credential without a tenant is exactly the bug D7
 * eliminates.
 */

import type { ControlPlaneCredentials } from "../../../authority/services"
import type { CredentialMetadata, CredentialWrite, SecretBackend } from "../types"
import { createEncryptedCloudflareBackend } from "../cloudflare"
import { envelopeKeyProviderFromEnv, type EnvelopeAdmin } from "../envelope"

type WorkerCredentialEnv = Record<string, string | undefined>
type StoredCredential = { meta: CredentialMetadata; secret: string }

export class HostedCredentialRecordError extends Error {
  readonly code = "hosted_credential_record_invalid"

  constructor(providerId: string, reason: string) {
    super(`Hosted credential record for "${providerId}" is invalid: ${reason}`)
  }
}

/** Default-off feature flag for the hosted credential surface. */
export const HOSTED_CREDENTIALS_FLAG = "CLAXEDO_HOSTED_CREDENTIALS_ENABLED"

export function hostedCredentialsEnabled(env: WorkerCredentialEnv = process.env): boolean {
  return env[HOSTED_CREDENTIALS_FLAG]?.trim() === "1"
}

/**
 * The ONLY sanctioned path to hosted credential bytes: envelope-encrypted
 * Cloudflare KV, partitioned to one org. Throws (fail closed) when the KEK
 * or KV configuration is missing. Later waves resolve `orgId` from the
 * authenticated principal (Decision 1 org partitioning) and call this
 * per-request or per-org — never the raw KV store.
 *
 * Carries the `EnvelopeAdmin` surface so a KEK rotation drain
 * (`credentials/rotate.ts`) can classify each slot's key-id without the
 * backend having to be reconstructed a second way.
 */
export function createHostedOrgSecretBackend(
  orgId: string,
  env: WorkerCredentialEnv = process.env,
): SecretBackend & EnvelopeAdmin {
  return createEncryptedCloudflareBackend({ orgId, env })
}

/**
 * Asserts the hosted credential configuration is complete. Throws with the
 * missing piece named. Used at composition time when the feature flag is on.
 */
function assertHostedCredentialConfig(env: WorkerCredentialEnv) {
  for (const name of ["CLAXEDO_CF_KV_URL", "CLAXEDO_CF_KV_TOKEN"] as const) {
    if (!env[name]?.trim()) {
      throw new Error(`${HOSTED_CREDENTIALS_FLAG}=1 but ${name} is not configured — refusing to start`)
    }
  }
  // Throws naming CLAXEDO_CREDENTIALS_KEK when absent or malformed.
  envelopeKeyProviderFromEnv(env)
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

  // Flag on: prove the encrypted store CAN be composed, at boot, or refuse to
  // start. The org-AGNOSTIC CRUD surface below stays fail-closed by design —
  // hosted credential access happens exclusively through the per-org
  // `hostedOrgCredentials(orgId)` surface, after org resolution succeeded.
  assertHostedCredentialConfig(env)

  const gated = (): never => {
    throw new Error(
      "Hosted credential management is org-partitioned (launch-plan D7 + D10); " +
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
 * D7: the org-partitioned hosted credential surface. One instance serves ONE
 * org; construct it per request (or cache per org) only after the caller's
 * org resolution succeeded — the verified `org_id` claim, never a
 * client-supplied value.
 *
 * Fail-closed properties:
 * - throws unless CLAXEDO_HOSTED_CREDENTIALS_ENABLED=1 (the default-off flag
 *   stays the rollout gate);
 * - throws on a blank orgId (org resolution must have succeeded);
 * - throws when the KEK or KV config is missing (same boot posture as
 *   `workerCredentials`);
 * - every byte goes through `createHostedOrgSecretBackend` — envelope
 *   encryption with a per-org HKDF subkey, so org A ciphertext never decrypts
 *   under org B even if a key were somehow shared.
 *
 * Storage shape: one encrypted KV value per provider id, holding
 * `{ meta, secret }`. Backend ids are org-prefixed
 * (`org/{orgId}/credential/{providerId}`) so two orgs writing the same
 * provider id can never collide on the underlying KV key — the HKDF
 * partition makes cross-org DECRYPTION impossible; the prefix makes
 * cross-org OVERWRITES impossible too. `listCredentials` intentionally
 * returns [] (KV has no sanctioned enumeration; the connections kit reads by
 * provider id only), and metadata ids equal provider ids (one auth
 * credential per provider, the host-store invariant).
 */
export function hostedOrgCredentials(
  orgId: string,
  env: WorkerCredentialEnv = process.env,
  opts: { now?: () => number } = {},
): ControlPlaneCredentials {
  if (!hostedCredentialsEnabled(env)) {
    throw new Error(`${HOSTED_CREDENTIALS_FLAG} is not enabled — hosted credential access stays fail-closed`)
  }
  const org = orgId?.trim()
  if (!org) {
    throw new Error("hostedOrgCredentials requires a non-empty orgId — org resolution must succeed before any credential access")
  }
  assertHostedCredentialConfig(env)
  const backend = createHostedOrgSecretBackend(org, env)
  const now = opts.now ?? Date.now

  const idFor = (providerId: string) => `org/${org}/credential/${providerId}`
  // The KV byte store's ref scheme is deterministic (`cf:{id}`, see
  // credentials/cloudflare.ts) — a metadata-keyed read needs get-by-provider,
  // so the ref is reconstructed here. The write path asserts the scheme on
  // every put, so drift fails loudly instead of silently missing reads.
  const refFor = (providerId: string) => `cf:${idFor(providerId)}`

  const read = async (providerId: string): Promise<StoredCredential | undefined> => {
    const raw = await backend.get(refFor(providerId))
    if (raw === null) return undefined
    return parseStoredCredential(raw, {
      orgId: org,
      providerId,
      secureRef: refFor(providerId),
    })
  }
  const write = async (record: StoredCredential): Promise<void> => {
    const ref = await backend.put(idFor(record.meta.provider_id), JSON.stringify(record))
    if (ref !== refFor(record.meta.provider_id)) {
      throw new Error("hosted credential backend ref scheme drifted — the read path would miss this write; refusing")
    }
  }

  return {
    // No KV enumeration by design: empty, never another org's rows.
    listCredentials: async () => [],
    getCredentialByProvider: async (providerId) => (await read(providerId))?.meta,
    getCredential: async (id) => (await read(id))?.meta,
    // Available-status-only, mirroring credentials/registry.ts resolveSecret.
    resolveCredentialSecret: async (providerId) => {
      const record = await read(providerId)
      if (!record || record.meta.status !== "available") return null
      return record.secret
    },
    // Verification retries must be able to re-check a prior failed result.
    resolveCredentialSecretById: async (id) => (await read(id))?.secret ?? null,
    putCredential: async (input: CredentialWrite) => {
      const existing = await read(input.provider_id)
      const timestamp = now()
      const meta: CredentialMetadata = {
        // One credential per provider in this per-org store: the metadata id
        // IS the provider id (updateCredentialStatus receives it back).
        id: input.provider_id,
        provider_id: input.provider_id,
        kind: input.kind,
        source: input.source,
        label: input.label ?? null,
        account_id: input.account_id ?? null,
        secure_ref: refFor(input.provider_id),
        status: "available",
        health: null,
        expires_at: input.expires_at ?? null,
        last_validated_at: null,
        last_error: null,
        created_at: existing?.meta.created_at ?? timestamp,
        updated_at: timestamp,
      }
      await write({ meta, secret: input.secret })
      return meta
    },
    deleteCredential: async (id) => {
      const record = await read(id)
      if (!record) return false
      await backend.delete(refFor(id))
      return true
    },
    // NOTE: the hosted KV layout keys one record per `providerId` with no
    // `kind` dimension, so the `kind` argument the local registry honours
    // cannot be applied here. That is safe today only because sandbox driver
    // configuration is 403'd in signed/hosted mode
    // (`local_only_sandbox_driver`), so sandbox credentials never reach this
    // adapter. Adding a kind to the KV key is required before that changes.
    deleteCredentialsByProvider: async (providerId) => {
      const record = await read(providerId)
      if (!record) return 0
      await backend.delete(refFor(providerId))
      return 1
    },
    updateCredentialStatus: async (id, status, error) => {
      const record = await read(id)
      if (!record) return
      record.meta.status = status
      record.meta.health = status === "expired" ? "expired" : null
      record.meta.last_error = error ?? null
      record.meta.updated_at = now()
      await write(record)
    },
    updateCredentialHealth: async (id, health, validatedAt) => {
      const record = await read(id)
      if (!record) return
      record.meta.health = health
      record.meta.status = health === "ok" ? "available" : health === "expired" ? "expired" : "error"
      record.meta.last_validated_at = validatedAt
      record.meta.last_error = health === "ok" ? null : health
      record.meta.updated_at = now()
      await write(record)
    },
    // No local credential stores exist on a hosted worker.
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}

const CREDENTIAL_KINDS = new Set(["api_key", "oauth_token", "subscription_session", "sandbox_driver"])
const CREDENTIAL_SOURCES = new Set(["managed", "local_only", "env", "upstream_sync"])
const CREDENTIAL_SCOPES = new Set(["local", "shared"])
const CREDENTIAL_STATUSES = new Set(["available", "expired", "revoked", "error"])
const CREDENTIAL_HEALTH = new Set(["ok", "auth_failed", "no_billing", "rate_capped", "expired"])
const CREDENTIAL_CONSENT_SURFACES = new Set(["desktop_discovery", "api_key", "scope_change", "cli", "migration"])

function parseStoredCredential(
  raw: string,
  expected: { orgId: string; providerId: string; secureRef: string },
): StoredCredential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new HostedCredentialRecordError(expected.providerId, "payload is not valid JSON")
  }
  if (!isRecord(value)) invalidStoredCredential(expected.providerId, "payload must be an object")
  if (!isRecord(value.meta)) invalidStoredCredential(expected.providerId, "meta must be an object")
  if (typeof value.secret !== "string") invalidStoredCredential(expected.providerId, "secret must be a string")

  const meta = value.meta
  if (meta.id !== expected.providerId) {
    invalidStoredCredential(expected.providerId, "meta.id must equal the requested provider id")
  }
  if (meta.provider_id !== expected.providerId) {
    invalidStoredCredential(expected.providerId, "meta.provider_id must equal the requested provider id")
  }
  if (!enumValue(meta.kind, CREDENTIAL_KINDS)) {
    invalidStoredCredential(expected.providerId, "meta.kind is unsupported")
  }
  if (!enumValue(meta.source, CREDENTIAL_SOURCES)) {
    invalidStoredCredential(expected.providerId, "meta.source is unsupported")
  }
  if (!enumValue(meta.status, CREDENTIAL_STATUSES)) {
    invalidStoredCredential(expected.providerId, "meta.status is unsupported")
  }
  if (meta.scope !== undefined && !enumValue(meta.scope, CREDENTIAL_SCOPES)) {
    invalidStoredCredential(expected.providerId, "meta.scope is unsupported")
  }
  if (meta.org_id !== undefined && meta.org_id !== expected.orgId) {
    invalidStoredCredential(expected.providerId, "meta.org_id does not match the credential partition")
  }
  if (meta.secure_ref !== undefined && meta.secure_ref !== expected.secureRef) {
    invalidStoredCredential(expected.providerId, "meta.secure_ref does not match the credential storage key")
  }
  if (!nullableString(meta.label) || !nullableString(meta.account_id) || !nullableString(meta.last_error)) {
    invalidStoredCredential(expected.providerId, "nullable metadata text fields must be strings or null")
  }
  if (meta.health !== undefined && meta.health !== null && !enumValue(meta.health, CREDENTIAL_HEALTH)) {
    invalidStoredCredential(expected.providerId, "meta.health is unsupported")
  }
  if (
    !finiteNumber(meta.created_at) ||
    !finiteNumber(meta.updated_at) ||
    !nullableFiniteNumber(meta.expires_at) ||
    !nullableFiniteNumber(meta.last_validated_at) ||
    !nullableFiniteNumber(meta.last_used_at)
  ) {
    invalidStoredCredential(expected.providerId, "metadata timestamps must be finite numbers or null")
  }
  if (meta.consent !== undefined && meta.consent !== null) {
    if (
      !isRecord(meta.consent) ||
      !finiteNumber(meta.consent.at) ||
      !enumValue(meta.consent.surface, CREDENTIAL_CONSENT_SURFACES)
    ) {
      invalidStoredCredential(expected.providerId, "meta.consent is invalid")
    }
  }
  return value as StoredCredential
}

function invalidStoredCredential(providerId: string, reason: string): never {
  throw new HostedCredentialRecordError(providerId, reason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function enumValue(value: unknown, values: Set<string>) {
  return typeof value === "string" && values.has(value)
}

function nullableString(value: unknown) {
  return value === undefined || value === null || typeof value === "string"
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
}

function nullableFiniteNumber(value: unknown) {
  return value === undefined || value === null || finiteNumber(value)
}
