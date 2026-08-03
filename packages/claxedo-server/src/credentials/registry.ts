/**
 * Credential registry — the central API for managing provider credentials.
 *
 * Coordinates between SQLite metadata (claxedo.db) and the secret backend.
 * Raw secret material never enters SQLite — only opaque backend references.
 *
 * ORG SCOPING (security invariant)
 * --------------------------------
 * Provider credentials are model-provider API keys and OAuth tokens — the
 * highest-value secret in the product. Every statement in this module is
 * scoped by `org_id`; there is no unscoped read, write, delete, or verify
 * path, and no wildcard.
 *
 * The `org` parameter defaults to `SINGLE_TENANT_ORG` (`__local__`), the named
 * partition that unsigned/loopback self-host resolves to. That default is a
 * fail-CLOSED default, not a convenience wildcard: a call site that forgets to
 * pass an org operates on the single-tenant partition only, so the worst
 * outcome of a missed call site is "cannot see this org's rows" — never "can
 * see another org's rows".
 */

import { randomUUID } from "crypto"
import { eq, and, desc, inArray, sql } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db/db"
import { ClaxedoProviderCredentialTable, SINGLE_TENANT_ORG } from "./provider-credential.sql"
import { getBackend } from "./backend-registry"
import type { CredentialHealth, CredentialMetadata, CredentialScope, CredentialWrite, CredentialStatus } from "./types"
import { Log } from "../platform/runtime/lib/log"
import { ensurePresetForProvider, removeAutoPresetForProvider } from "../sandbox/network/policy"
import { credentialSecretInScope, type CredentialSecretScope } from "./secret-scope"

export { SINGLE_TENANT_ORG } from "./provider-credential.sql"

const log = Log.create({ service: "credentials-registry" })
const exclusiveAuthKinds = ["api_key", "oauth_token"] as const

/**
 * The tenant a credential operation runs as. Blank/whitespace is NOT a
 * wildcard — it collapses to the named single-tenant partition.
 */
export type CredentialOrgScope = string

/** Normalize an org scope. Never returns an empty string, never a wildcard. */
export function credentialOrg(org?: CredentialOrgScope | null): string {
  const value = org?.trim()
  return value ? value : SINGLE_TENANT_ORG
}

/** The one scope predicate. Every statement in this module composes with it. */
function inOrg(org?: CredentialOrgScope | null) {
  return eq(ClaxedoProviderCredentialTable.org_id, credentialOrg(org))
}

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
export async function putCredential(
  input: CredentialWrite,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<CredentialMetadata> {
  const orgId = credentialOrg(org)
  const backend = getBackend()
  const ok = await backend.probe()
  if (!ok) {
    throw new Error("Secret backend unavailable — refusing to store credential")
  }

  // Check for existing credential for this org+provider+kind. The org
  // predicate is what stops org A's write from adopting (and then
  // overwriting) org B's row for the same provider.
  const existing = ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoProviderCredentialTable)
      .where(
        and(
          inOrg(orgId),
          eq(ClaxedoProviderCredentialTable.provider_id, input.provider_id),
          eq(ClaxedoProviderCredentialTable.kind, input.kind),
        ),
      )
      .all(),
  ).find((credential) => (credential.account_id ?? undefined) === input.account_id)
  const scope = input.scope ?? existing?.scope ?? "local"
  if (scope === "shared" && !input.consent && !existing?.consent_json) {
    throw new Error("Shared credentials require explicit consent")
  }

  // Exclusive-kind replacement DELETES rows. Unscoped, org A storing an
  // `openai` api_key would delete org B's `openai` oauth_token — cross-tenant
  // denial of service. Scoped to the writer's org it can only replace its own.
  const replacing = exclusiveAuthKinds.includes(input.kind as (typeof exclusiveAuthKinds)[number])
    ? ClaxedoDB.use((db) =>
        db
          .select()
          .from(ClaxedoProviderCredentialTable)
          .where(
            and(
              inOrg(orgId),
              eq(ClaxedoProviderCredentialTable.provider_id, input.provider_id),
              inArray(ClaxedoProviderCredentialTable.kind, [...exclusiveAuthKinds]),
            ),
          )
          .all(),
      )
        .filter((credential) => (credential.account_id ?? undefined) === input.account_id)
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
    org_id: orgId,
    provider_id: input.provider_id,
    kind: input.kind,
    source: input.source,
    label: input.label ?? null,
    account_id: input.account_id ?? null,
    secure_ref: ref,
    status: "available" as const,
    health: null,
    expires_at: input.expires_at ?? null,
    last_validated_at: null,
    scope,
    consent_json: input.consent ? JSON.stringify(input.consent) : existing?.consent_json ?? null,
    last_used_at: existing?.last_used_at ?? null,
    last_error: null,
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  }

  const replaced = replacing.filter((cred) => cred.id !== id)

  ClaxedoDB.transaction((db) => {
    if (replaced.length > 0) {
      db.delete(ClaxedoProviderCredentialTable)
        .where(and(inOrg(orgId), inArray(ClaxedoProviderCredentialTable.id, replaced.map((cred) => cred.id))))
        .run()
    }
    if (existing) {
      db.update(ClaxedoProviderCredentialTable)
        .set(row)
        .where(and(inOrg(orgId), eq(ClaxedoProviderCredentialTable.id, id)))
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

  log.info("Credential stored", { id, org_id: orgId, provider_id: input.provider_id, kind: input.kind })

  // Auto-add network preset so sandbox egress is allowed for this provider
  ensurePresetForProvider(input.provider_id)

  return toMetadata(row as CredentialRow)
}

type CredentialRow = typeof ClaxedoProviderCredentialTable.$inferSelect

function toMetadata(row: CredentialRow): CredentialMetadata {
  const consent = (() => {
    if (!row.consent_json) return null
    try {
      return JSON.parse(row.consent_json) as CredentialMetadata["consent"]
    } catch {
      return null
    }
  })()
  return {
    ...row,
    scope: row.scope as CredentialScope,
    consent,
  } as unknown as CredentialMetadata
}

/** List credential metadata (no secrets) for one org. */
export function listCredentials(org: CredentialOrgScope = SINGLE_TENANT_ORG): CredentialMetadata[] {
  return safeRead("credential list", [], () =>
    ClaxedoDB.use((db) =>
      db.select().from(ClaxedoProviderCredentialTable).where(inOrg(org)).all().map(toMetadata),
    ),
  )
}

/**
 * Ordering for "the credential to use for this provider" when more than one
 * exists — a user with two ChatGPT accounts has two `codex-acp` credentials.
 *
 * Write order (`updated_at` alone) is not a preference: importing an older
 * account last made every session resolve to the older, often already-revoked
 * token. Rank by likelihood of working instead — usable status, not known
 * expired, then the furthest-out expiry (no expiry sorts first: an API key
 * outlives any token), and only then most-recently-written as a tiebreak.
 */
const providerPreference = [
  sql`case when ${ClaxedoProviderCredentialTable.status} = 'available' then 0 else 1 end`,
  sql`case when ${ClaxedoProviderCredentialTable.health} = 'expired' then 1 else 0 end`,
  sql`coalesce(${ClaxedoProviderCredentialTable.expires_at}, 9223372036854775807) desc`,
  desc(ClaxedoProviderCredentialTable.updated_at),
]

function listCredentialsByProviderPreference(org: CredentialOrgScope) {
  return safeRead("credential preference list", [], () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(inOrg(org))
        .orderBy(...providerPreference)
        .all()
        .map(toMetadata),
    ),
  )
}

/**
 * Get credential metadata by provider ID, optionally scoped to one `kind`.
 *
 * `provider_id` is NOT unique — `putCredential` upserts on (org, provider_id,
 * kind, account_id), so one id can legitimately hold several rows. Several
 * sandbox driver ids collide with model-provider ids (`vercel` is both), and
 * without `kind` this returns whichever row sorts first, which for a sandbox
 * lookup can be the user's model-provider API key. Callers that mean one kind
 * should say so; omitting it keeps the historical any-kind behaviour.
 */
export function getCredentialByProvider(
  providerId: string,
  kind?: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): CredentialMetadata | undefined {
  const row = safeRead<CredentialRow | undefined>("credential lookup", undefined, () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(
          kind
            ? and(
                inOrg(org),
                eq(ClaxedoProviderCredentialTable.provider_id, providerId),
                eq(ClaxedoProviderCredentialTable.kind, kind),
              )
            : and(inOrg(org), eq(ClaxedoProviderCredentialTable.provider_id, providerId)),
        )
        .orderBy(...providerPreference)
        .get(),
    ),
  )
  return row ? toMetadata(row) : undefined
}

/** Credential lookup for request paths where a registry outage must remain distinguishable from an absent credential. */
export function requireCredentialRegistryLookup(
  providerId: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): CredentialMetadata | undefined {
  const row = ClaxedoDB.use((db) =>
    db
      .select()
        .from(ClaxedoProviderCredentialTable)
        .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.provider_id, providerId)))
        .orderBy(...providerPreference)
        .get(),
  )
  return row ? toMetadata(row) : undefined
}

/** Get credential metadata by ID, within one org. */
export function getCredential(
  id: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): CredentialMetadata | undefined {
  const row = safeRead<CredentialRow | undefined>("credential read", undefined, () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
        .get(),
    ),
  )
  return row ? toMetadata(row) : undefined
}

/** Resolve a credential's raw secret material — only call at trusted fanout points. */
export async function resolveSecret(
  providerId: string,
  kind?: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<string | null> {
  const cred = getCredentialByProvider(providerId, kind, org)
  if (!cred?.secure_ref) return null
  if (cred.status !== "available") return null

  const secret = await getBackend().get(cred.secure_ref)
  if (secret) touchCredential(cred.id, org)
  return secret
}

/** Resolve one credential by storage id for a trusted verification retry. */
export async function resolveSecretById(
  id: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<string | null> {
  const cred = getCredential(id, org)
  if (!cred?.secure_ref) return null
  const secret = await getBackend().get(cred.secure_ref)
  if (secret) touchCredential(cred.id, org)
  return secret
}

function touchCredential(id: string, org?: CredentialOrgScope) {
  ClaxedoDB.use((db) => db
    .update(ClaxedoProviderCredentialTable)
    .set({ last_used_at: now() })
    .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
    .run())
}

/**
 * Replace stored secret material in place, keeping the credential's identity,
 * scope, and consent. Used when an OAuth credential is renewed during
 * verification — `putCredential` would be the wrong tool: it resets health and
 * re-runs the exclusive-kind replacement logic for what is the same login.
 */
export async function updateCredentialSecret(
  id: string,
  secret: string,
  expiresAt?: number,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<boolean> {
  const credential = getCredential(id, org)
  if (!credential) return false
  const backend = getBackend()
  const ref = await backend.put(id, secret)
  if (credential.secure_ref && credential.secure_ref !== ref) {
    await backend.delete(credential.secure_ref).catch((err) => {
      log.warn("Failed to delete superseded secret ref", { id, error: String(err) })
    })
  }
  ClaxedoDB.use((db) => db
    .update(ClaxedoProviderCredentialTable)
    .set({
      secure_ref: ref,
      expires_at: expiresAt ?? credential.expires_at ?? null,
      updated_at: now(),
    })
    .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
    .run())
  return true
}

export function updateCredentialScope(
  id: string,
  scope: CredentialScope,
  consentAt: number,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
) {
  const credential = getCredential(id, org)
  if (!credential) return false
  ClaxedoDB.use((db) => db
    .update(ClaxedoProviderCredentialTable)
    .set({
      scope,
      source: scope === "shared" ? "managed" : "local_only",
      consent_json: JSON.stringify({ at: consentAt, surface: "scope_change" }),
      updated_at: now(),
    })
    .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
    .run())
  return true
}

/** Update credential status (e.g. mark expired or revoked). */
export function updateCredentialStatus(
  id: string,
  status: CredentialStatus,
  error?: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): void {
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoProviderCredentialTable)
      .set({
        status,
        health: status === "expired" ? "expired" : null,
        last_error: error ?? null,
        updated_at: now(),
      })
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
      .run(),
  )
}

/** Persist the provider-backed health result consumed by every credential surface. */
export function updateCredentialHealth(
  id: string,
  health: CredentialHealth,
  validatedAt: number,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): void {
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoProviderCredentialTable)
      .set({
        health,
        status: health === "ok" ? "available" : health === "expired" ? "expired" : "error",
        last_validated_at: validatedAt,
        last_error: health === "ok" ? null : health,
        updated_at: now(),
      })
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
      .run(),
  )
}

/** Delete a credential and its backend secret. */
export async function deleteCredential(
  id: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<boolean> {
  const cred = getCredential(id, org)
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
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
      .run(),
  )

  log.info("Credential deleted", { id, org_id: credentialOrg(org), provider_id: cred.provider_id })

  // Remove auto-created network preset if no other creds need it
  removeAutoPresetForProvider(cred.provider_id)

  return true
}

/** Delete all credentials for a provider. */
/**
 * Delete every credential for a provider in one org, optionally scoped to one
 * `kind`.
 *
 * Unscoped by kind this is genuinely destructive across features: `vercel` is
 * both a sandbox driver id and a model-provider id, so an unscoped delete
 * triggered by "Remove" in Sandbox settings also destroyed the user's Vercel
 * model API key. Pass `kind` whenever the caller owns only one kind of
 * credential. The ORG scope is not optional — it is what keeps one tenant's
 * "remove provider" from wiping every other tenant's key for that provider.
 */
export async function deleteCredentialsByProvider(
  providerId: string,
  kind?: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<number> {
  const scope = kind
    ? and(
        inOrg(org),
        eq(ClaxedoProviderCredentialTable.provider_id, providerId),
        eq(ClaxedoProviderCredentialTable.kind, kind),
      )
    : and(inOrg(org), eq(ClaxedoProviderCredentialTable.provider_id, providerId))

  const creds = ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoProviderCredentialTable)
      .where(scope)
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
      .where(scope)
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

function preferredCredentialPerProvider(credentials: CredentialMetadata[]) {
  const selected = new Set<string>()
  return credentials.filter((credential) => {
    if (selected.has(credential.provider_id)) return false
    selected.add(credential.provider_id)
    return true
  })
}

/**
 * Resolve all managed credentials as a provider→secret map, for ONE org.
 * Only call at trusted fanout points such as ACP spawn/config replay.
 */
export async function resolveAllSecrets(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<Record<string, string>> {
  const creds = preferredCredentialPerProvider(
    listCredentialsByProviderPreference(org)
      .filter((c) => c.status === "available" && c.secure_ref && fanoutEligible(c)),
  )
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

export async function resolveSecretsForScope(
  scope: CredentialSecretScope = "local",
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<Record<string, string>> {
  const creds = preferredCredentialPerProvider(
    listCredentialsByProviderPreference(org)
      .filter((c) => c.status === "available" && c.secure_ref && fanoutEligible(c))
      .filter((c) => credentialSecretInScope({ source: c.source, scope: c.scope }, scope)),
  )
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
