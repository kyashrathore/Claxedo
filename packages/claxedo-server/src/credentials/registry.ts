/**
 * Credential registry — the central API for managing provider credentials.
 *
 * Coordinates between SQLite metadata (claxedo.db) and the secret backend.
 * Raw secret material never enters SQLite — only opaque backend references.
 */

import { randomUUID } from "crypto"
import { eq, and, inArray } from "drizzle-orm"
import { ClaxedoDB } from "../storage/db"
import { ClaxedoProviderCredentialTable } from "../storage/provider-credential.sql"
import { getBackend } from "./store"
import type { CredentialMetadata, CredentialWrite, CredentialStatus } from "./types"
import { Log } from "../log"
import { ensurePresetForProvider, removeAutoPresetForProvider } from "../network/policy"
import { credentialSecretInScope, type CredentialSecretScope } from "./secret-scope"

const log = Log.create({ service: "credentials-registry" })
const exclusiveAuthKinds = ["api_key", "oauth_token"] as const

function now() {
  return Date.now()
}

function safeRead<T>(label: string, fallback: T, read: () => T): T {
  try {
    return read()
  } catch (error) {
    log.warn(`${label} unavailable`, { error: String(error) })
    return fallback
  }
}

/** Create or update a credential with its secret stored in the backend. */
export async function putCredential(input: CredentialWrite): Promise<CredentialMetadata> {
  const backend = getBackend()
  const ok = await backend.probe()
  if (!ok) {
    throw new Error("Secret backend unavailable — refusing to store credential")
  }

  // Check for existing credential for this provider+kind
  const existing = ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoProviderCredentialTable)
      .where(
        and(
          eq(ClaxedoProviderCredentialTable.provider_id, input.provider_id),
          eq(ClaxedoProviderCredentialTable.kind, input.kind),
        ),
      )
      .get(),
  )

  const replacing = exclusiveAuthKinds.includes(input.kind as (typeof exclusiveAuthKinds)[number])
    ? ClaxedoDB.use((db) =>
        db
          .select()
          .from(ClaxedoProviderCredentialTable)
          .where(
            and(
              eq(ClaxedoProviderCredentialTable.provider_id, input.provider_id),
              inArray(ClaxedoProviderCredentialTable.kind, [...exclusiveAuthKinds]),
            ),
          )
          .all(),
      )
    : []

  const id = existing?.id ?? randomUUID()
  const ref = await backend.put(id, input.secret)

  // Clean up old backend ref if updating
  if (existing?.secure_ref && existing.secure_ref !== ref) {
    await backend.delete(existing.secure_ref).catch((err) => {
      log.warn("Failed to delete old secret ref", { id, error: String(err) })
    })
  }

  const ts = now()
  const row = {
    id,
    provider_id: input.provider_id,
    kind: input.kind,
    source: input.source,
    label: input.label ?? null,
    account_id: input.account_id ?? null,
    secure_ref: ref,
    status: "available" as const,
    expires_at: input.expires_at ?? null,
    last_validated_at: ts,
    last_error: null,
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  }

  const replaced = replacing.filter((cred) => cred.id !== id)

  ClaxedoDB.transaction((db) => {
    if (replaced.length > 0) {
      db.delete(ClaxedoProviderCredentialTable)
        .where(inArray(ClaxedoProviderCredentialTable.id, replaced.map((cred) => cred.id)))
        .run()
    }
    if (existing) {
      db.update(ClaxedoProviderCredentialTable)
        .set(row)
        .where(eq(ClaxedoProviderCredentialTable.id, id))
        .run()
    } else {
      db.insert(ClaxedoProviderCredentialTable).values(row).run()
    }
  })

  for (const cred of replaced) {
    if (!cred.secure_ref) continue
    await backend.delete(cred.secure_ref).catch((err) => {
      log.warn("Failed to delete replaced secret ref", { id: cred.id, error: String(err) })
    })
  }

  log.info("Credential stored", { id, provider_id: input.provider_id, kind: input.kind })

  // Auto-add network preset so sandbox egress is allowed for this provider
  ensurePresetForProvider(input.provider_id)

  return row
}

type CredentialRow = typeof ClaxedoProviderCredentialTable.$inferSelect

function toMetadata(row: CredentialRow): CredentialMetadata {
  return row as unknown as CredentialMetadata
}

/** List all credential metadata (no secrets). */
export function listCredentials(): CredentialMetadata[] {
  return safeRead("credential list", [], () =>
    ClaxedoDB.use((db) =>
      db.select().from(ClaxedoProviderCredentialTable).all().map(toMetadata),
    ),
  )
}

/** Get credential metadata by provider ID. */
export function getCredentialByProvider(providerId: string): CredentialMetadata | undefined {
  const row = safeRead<CredentialRow | undefined>("credential lookup", undefined, () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(eq(ClaxedoProviderCredentialTable.provider_id, providerId))
        .get(),
    ),
  )
  return row ? toMetadata(row) : undefined
}

/** Get credential metadata by ID. */
export function getCredential(id: string): CredentialMetadata | undefined {
  const row = safeRead<CredentialRow | undefined>("credential read", undefined, () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(eq(ClaxedoProviderCredentialTable.id, id))
        .get(),
    ),
  )
  return row ? toMetadata(row) : undefined
}

/** Resolve a credential's raw secret material — only call at trusted fanout points. */
export async function resolveSecret(providerId: string): Promise<string | null> {
  const cred = getCredentialByProvider(providerId)
  if (!cred?.secure_ref) return null
  if (cred.status !== "available") return null

  const backend = getBackend()
  return backend.get(cred.secure_ref)
}

/** Update credential status (e.g. mark expired or revoked). */
export function updateCredentialStatus(id: string, status: CredentialStatus, error?: string): void {
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoProviderCredentialTable)
      .set({
        status,
        last_error: error ?? null,
        updated_at: now(),
      })
      .where(eq(ClaxedoProviderCredentialTable.id, id))
      .run(),
  )
}

/** Delete a credential and its backend secret. */
export async function deleteCredential(id: string): Promise<boolean> {
  const cred = getCredential(id)
  if (!cred) return false

  if (cred.secure_ref) {
    const backend = getBackend()
    await backend.delete(cred.secure_ref).catch((err) => {
      log.warn("Failed to delete backend secret", { id, error: String(err) })
    })
  }

  ClaxedoDB.use((db) =>
    db
      .delete(ClaxedoProviderCredentialTable)
      .where(eq(ClaxedoProviderCredentialTable.id, id))
      .run(),
  )

  log.info("Credential deleted", { id, provider_id: cred.provider_id })

  // Remove auto-created network preset if no other creds need it
  removeAutoPresetForProvider(cred.provider_id)

  return true
}

/** Delete all credentials for a provider. */
export async function deleteCredentialsByProvider(providerId: string): Promise<number> {
  const creds = ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoProviderCredentialTable)
      .where(eq(ClaxedoProviderCredentialTable.provider_id, providerId))
      .all(),
  )

  const backend = getBackend()
  for (const cred of creds) {
    if (cred.secure_ref) {
      await backend.delete(cred.secure_ref).catch(() => {})
    }
  }

  ClaxedoDB.use((db) =>
    db
      .delete(ClaxedoProviderCredentialTable)
      .where(eq(ClaxedoProviderCredentialTable.provider_id, providerId))
      .run(),
  )

  // Remove auto-created network preset
  removeAutoPresetForProvider(providerId)

  return creds.length
}

/**
 * Fanout ALLOWLIST. The harness auth fanout exists for ONE purpose: let the
 * agent inside a sandbox use the user's own model/AI-provider auth — the same
 * Claude/Codex/Cursor/OpenAI subscription or API key they use locally. So a
 * credential fans out into a sandbox runtime-config snapshot only when it is
 * model/agent-provider auth: kind ∈ {api_key, oauth_token,
 * subscription_session} AND a bare (non-namespaced) provider id.
 *
 * Everything else stays server-side and reaches its consumer another way:
 *  - `kind: "sandbox_driver"` (Daytona/Vercel/Cloudflare/…): provisioning
 *    credentials the DRIVER injects natively; the driver API token controls
 *    EVERY sandbox and must never sit in a sandbox's own config. Resolved for
 *    provisioning via `config.sandbox_driver`, never through this fanout.
 *  - `integration:*` (connections) and `channel:*` (channel state): reach
 *    consumers only through their own gated paths (the connections token
 *    endpoint, the channel runtime).
 *
 * Allowlist by design, not a denylist: a future non-model credential kind is
 * fenced by the kind check, and a future namespaced id by the id check, so a
 * new credential type cannot silently start leaking into sandboxes.
 */
const FANOUT_ELIGIBLE_KINDS = new Set<CredentialMetadata["kind"]>([
  "api_key",
  "oauth_token",
  "subscription_session",
])

function fanoutEligible(cred: CredentialMetadata): boolean {
  return FANOUT_ELIGIBLE_KINDS.has(cred.kind) && !cred.provider_id.includes(":")
}

/**
 * Resolve all managed credentials as a provider→secret map.
 * Only call at trusted fanout points such as ACP spawn/config replay.
 */
export async function resolveAllSecrets(): Promise<Record<string, string>> {
  const creds = listCredentials().filter((c) => c.status === "available" && c.secure_ref && fanoutEligible(c))
  const backend = getBackend()
  const result: Record<string, string> = {}

  for (const cred of creds) {
    try {
      const secret = await backend.get(cred.secure_ref!)
      if (secret) result[cred.provider_id] = secret
    } catch {
      log.warn("Failed to resolve credential secret", {
        id: cred.id,
        provider_id: cred.provider_id,
      })
    }
  }

  return result
}

export async function resolveSecretsForScope(scope: CredentialSecretScope = "local"): Promise<Record<string, string>> {
  const creds = listCredentials()
    .filter((c) => c.status === "available" && c.secure_ref && fanoutEligible(c))
    .filter((c) => credentialSecretInScope({ source: c.source }, scope))
  const backend = getBackend()
  const result: Record<string, string> = {}

  for (const cred of creds) {
    try {
      const secret = await backend.get(cred.secure_ref!)
      if (secret) result[cred.provider_id] = secret
    } catch {
      log.warn("Failed to resolve scoped credential secret", {
        id: cred.id,
        provider_id: cred.provider_id,
        scope,
      })
    }
  }

  return result
}
