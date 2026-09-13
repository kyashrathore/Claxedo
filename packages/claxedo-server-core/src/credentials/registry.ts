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

import { createHash, randomUUID } from "crypto"
import { eq, and, desc, inArray, sql } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db"
import { ClaxedoProviderCredentialTable, SINGLE_TENANT_ORG } from "./provider-credential.sql"
import { getBackend } from "./backend-registry"
import { isOneOf, parseJsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import {
  CREDENTIAL_CONSENT_SURFACES,
  type CredentialConsent,
  type CredentialHealth,
  type CredentialKind,
  type CredentialMetadata,
  type CredentialScope,
  type CredentialWrite,
  type CredentialStatus,
  type SetActiveCredentialsResult,
} from "./types"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
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

/**
 * Rows belonging to one owner. `coalesce` matches the active index's own
 * expression, so a predicate and the uniqueness it relies on agree about which
 * rows are the team's.
 */
function ownedBy(owner: string | null) {
  return sql`coalesce(${ClaxedoProviderCredentialTable.owner}, '') = ${owner ?? ""}`
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

/**
 * The identity a pasted key carries when the provider gives none.
 *
 * The upsert key includes `account_id`, so an API key saved without one
 * overwrote whatever was stored for that provider and kind: a user could hold
 * exactly one, and a second paste silently destroyed the first. Hashing the
 * secret makes two keys two rows and the same key idempotent. The trailing
 * characters are the ones the provider's own dashboard shows, so the row is
 * recognisable in the accounts list without ever revealing the key.
 *
 * OAuth and subscription rows carry the provider's account id already, and
 * everything that is not harness auth (sandbox drivers, `integration:` and
 * `channel:` secrets) has one row per provider by design.
 */
function pastedAccountId(input: CredentialWrite): string | undefined {
  if (input.kind !== "api_key" || !fanoutEligibleAuth(input.kind, input.provider_id)) return undefined
  return `fp_${createHash("sha256").update(input.secret).digest("hex").slice(0, 8)}…${input.secret.slice(-4)}`
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

  const accountId = input.account_id ?? pastedAccountId(input)

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
  ).find((credential) => (credential.account_id ?? undefined) === accountId)
  const scope = input.scope ?? existing?.scope ?? "local"
  if (scope === "shared" && !input.consent && !existing?.consent_json) {
    throw new Error("Shared credentials require explicit consent")
  }

  // Exclusive-kind replacement DELETES rows. Unscoped, org A storing an
  // `openai` api_key would delete org B's `openai` oauth_token — cross-tenant
  // denial of service. Scoped to the writer's org it can only replace its own.
  const replacing = exclusiveAuthKinds.some((kind) => kind === input.kind)
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
        .filter((credential) => (credential.account_id ?? undefined) === accountId)
    : []

  const id = existing?.id ?? randomUUID()
  const replaced = replacing.filter((cred) => cred.id !== id)
  const owner = existing?.owner ?? null

  const ref = await backend.put(id, input.secret)

  // Clean up old backend ref if updating
  if (existing?.secure_ref && existing.secure_ref !== ref) {
    await backend.delete(existing.secure_ref).catch((err) => {
      log.warn("Failed to delete old secret ref", { id, error: String(err) })
    })
  }

  const ts = now()
  const fields = {
    id,
    org_id: orgId,
    owner,
    provider_id: input.provider_id,
    kind: input.kind,
    source: input.source,
    label: input.label ?? null,
    account_id: accountId ?? null,
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

  /**
   * A save takes the mark only from an account that cannot be used. A WORKING
   * active account keeps it — adding a second login must not silently move
   * every later turn onto it, and switching is `setActiveCredentials`. An
   * active account the provider has since rejected or expired YIELDS: without
   * that, pasting a corrected key leaves the broken one chosen, the fanout
   * sends nothing, and the harness falls back to the machine login with no
   * sign of why.
   *
   * The holder is cleared in the same statement run as the new row's write,
   * because the partial unique index refuses to see two marks at once.
   *
   * Read inside the write's own transaction because the secret backend is
   * awaited above: two logins imported together would both see an unmarked
   * provider and both claim the mark, which the index then rejects — losing
   * the import rather than the race.
   */
  const stored = ClaxedoDB.transaction((db) => {
    if (replaced.length > 0) {
      db.delete(ClaxedoProviderCredentialTable)
        .where(and(inOrg(orgId), inArray(ClaxedoProviderCredentialTable.id, replaced.map((cred) => cred.id))))
        .run()
    }
    const holders = db
      .select()
      .from(ClaxedoProviderCredentialTable)
      .where(
        and(
          inOrg(orgId),
          eq(ClaxedoProviderCredentialTable.provider_id, input.provider_id),
          ownedBy(owner),
          eq(ClaxedoProviderCredentialTable.is_active, true),
        ),
      )
      .all()
      .filter((other) => other.id !== id)
    const usable = holders.some((other) => other.status === "available")
    const row = { ...fields, is_active: fanoutEligibleAuth(input.kind, input.provider_id) && !usable }
    if (row.is_active && holders.length > 0) {
      db.update(ClaxedoProviderCredentialTable)
        .set({ is_active: false, updated_at: ts })
        .where(and(inOrg(orgId), inArray(ClaxedoProviderCredentialTable.id, holders.map((other) => other.id))))
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
    return row
  })

  for (const cred of replaced) {
    if (!cred.secure_ref) continue
    await backend.delete(cred.secure_ref).catch((err) => {
      log.warn("Failed to delete replaced secret ref", { id: cred.id, error: String(err) })
    })
  }

  log.info("Credential stored", { id, org_id: orgId, provider_id: input.provider_id, kind: input.kind })

  return toMetadata(stored as CredentialRow)
}

type CredentialRow = typeof ClaxedoProviderCredentialTable.$inferSelect

/** The stored consent record, or nothing when the column is absent or unreadable. */
function readConsent(raw: string | null): CredentialConsent | null {
  if (!raw) return null
  const value = parseJsonRecord(raw)
  if (!value || typeof value.at !== "number") return null
  return isOneOf(value.surface, CREDENTIAL_CONSENT_SURFACES) ? { at: value.at, surface: value.surface } : null
}

function toMetadata(row: CredentialRow): CredentialMetadata {
  return { ...row, consent: readConsent(row.consent_json) }
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
 * exists — a user with two ChatGPT accounts has two native Codex credentials.
 *
 * The account the user marked active answers that question; it is the only
 * choice a surface can show and the only one they can change. Below the mark
 * the most recent write wins, which decides only between rows that never carry
 * one: sandbox driver tokens and `integration:`/`channel:` secrets, of which a
 * provider holds a single row per kind.
 */
const activeFirst = [
  desc(ClaxedoProviderCredentialTable.is_active),
  desc(ClaxedoProviderCredentialTable.updated_at),
]

/** The scope one mark is unique within: a partition of the active index. */
function markPartition(row: CredentialRow) {
  return `${row.owner ?? ""} ${row.provider_id}`
}

/**
 * Mark one account as the one its providers run on.
 *
 * Takes every row that stores the account, because one login is saved once per
 * binding a harness has — a Claude login is a `claude-acp` row and a
 * `claude-sdk` row — and a switch that moved one of them would leave the next
 * turn on the old account through the other.
 *
 * Everything is read and refused before anything is written, and the whole call
 * is one transaction: a caller never sees the account marked on some bindings
 * and not others, and the clear-then-set pair never leaves two marks in one
 * partition for the unique index to reject.
 */
export function setActiveCredentials(
  ids: readonly string[],
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): SetActiveCredentialsResult {
  const orgId = credentialOrg(org)
  return ClaxedoDB.transaction((db) => {
    const rows: CredentialRow[] = []
    for (const id of ids) {
      const row = db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(and(inOrg(orgId), eq(ClaxedoProviderCredentialTable.id, id)))
        .get()
      if (!row) return { ok: false, reason: "not_found" }
      if (!fanoutEligible(toMetadata(row))) return { ok: false, reason: "not_eligible" }
      rows.push(row)
    }
    // Two rows in one partition cannot both hold the mark, and nothing here can
    // say which of them the caller meant.
    if (new Set(rows.map(markPartition)).size !== rows.length) return { ok: false, reason: "ambiguous" }

    const ts = now()
    for (const row of rows) {
      db.update(ClaxedoProviderCredentialTable)
        .set({ is_active: false, updated_at: ts })
        .where(
          and(
            inOrg(orgId),
            eq(ClaxedoProviderCredentialTable.provider_id, row.provider_id),
            ownedBy(row.owner),
            eq(ClaxedoProviderCredentialTable.is_active, true),
          ),
        )
        .run()
    }
    for (const row of rows) {
      db.update(ClaxedoProviderCredentialTable)
        .set({ is_active: true, updated_at: ts })
        .where(and(inOrg(orgId), eq(ClaxedoProviderCredentialTable.id, row.id)))
        .run()
    }
    return { ok: true, credentials: rows.map((row) => toMetadata({ ...row, is_active: true, updated_at: ts })) }
  })
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
  kind?: CredentialKind,
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
        .orderBy(...activeFirst)
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
        .orderBy(...activeFirst)
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
  kind?: CredentialKind,
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
  kind?: CredentialKind,
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

function fanoutEligibleAuth(kind: CredentialKind, providerId: string): boolean {
  return FANOUT_ELIGIBLE_KINDS.has(kind) && !providerId.includes(":")
}

function fanoutEligible(cred: CredentialMetadata): boolean {
  return fanoutEligibleAuth(cred.kind, cred.provider_id)
}

/**
 * The accounts marked active in one org. The partial unique index makes this
 * at most one row per (owner, provider), so every fanout reads one account per
 * provider without ranking anything: a provider whose accounts are all unmarked
 * sends nothing, and the harness runs on the login it holds on the machine.
 */
function activeCredentials(org: CredentialOrgScope): CredentialMetadata[] {
  return safeRead("active credential list", [], () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.is_active, true)))
        .all()
        .map(toMetadata),
    ),
  )
}

/**
 * Resolve all managed credentials as a provider→secret map, for ONE org.
 * Only call at trusted fanout points such as ACP spawn/config replay.
 */
export async function resolveAllSecrets(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<Record<string, string>> {
  const creds = activeCredentials(org)
    .filter((c) => c.status === "available" && c.secure_ref && fanoutEligible(c))
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

/**
 * The rows the fanout sends for a scope, one per provider, without their
 * secrets. This is the only place the "which credential runs" question is
 * answered, so a surface that shows it reads the same selection.
 *
 * The scope filter runs after the mark, not instead of it: a user whose active
 * account is not shared sends nothing into a sandbox even when another of their
 * accounts would qualify, because silently running a sandbox on an account the
 * user did not choose is the thing the mark exists to stop.
 */
export function selectCredentialsForScope(
  scope: CredentialSecretScope = "local",
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): CredentialMetadata[] {
  return selectActiveCredentialsForScope(scope, org)
    .flatMap((row) => row.unavailable ? [] : [row.credential])
}

export type ScopedCredentialSelection = {
  credential: CredentialMetadata
  /** Absent when the account can be used; otherwise why it cannot. */
  unavailable?: string
}

/**
 * Every account the operator marked for a provider in this scope, usable or
 * not.
 *
 * A caller that can only consume a working credential reads
 * `selectCredentialsForScope`. A caller that must distinguish "no account
 * chosen" from "the chosen account is unusable" reads this instead: dropping a
 * withdrawn row makes the two indistinguishable, and the harness then runs on
 * whatever login its machine holds.
 */
export function selectActiveCredentialsForScope(
  scope: CredentialSecretScope = "local",
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): ScopedCredentialSelection[] {
  return activeCredentials(org)
    .filter((credential) => fanoutEligible(credential) && credentialSecretInScope(credential, scope))
    .map((credential) => {
      const unavailable = credentialUnavailableForScope(credential, scope)
      return unavailable ? { credential, unavailable } : { credential }
    })
}

export async function resolveSecretsForScope(
  scope: CredentialSecretScope = "local",
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<Record<string, string>> {
  const creds = selectCredentialsForScope(scope, org)
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

function credentialAvailableForScope(credential: CredentialMetadata, scope: CredentialSecretScope) {
  return credentialSecretInScope(credential, scope) && !credentialUnavailableForScope(credential, scope)
}

/**
 * Why an in-scope account cannot be used, or `undefined` when it can. The
 * health is preferred over the status because a health verdict names what the
 * provider said (`auth_failed`, `no_billing`) where the status only records
 * that something went wrong.
 */
function credentialUnavailableForScope(
  credential: CredentialMetadata,
  scope: CredentialSecretScope,
): string | undefined {
  if (!credential.secure_ref) return "no_secret"
  if (credential.health === "expired") return "expired"
  if (credential.expires_at != null && credential.expires_at <= now()) return "expired"
  if (credential.status !== "available") return credential.health ?? credential.status
  if (scope === "shared" && !credential.consent) return "consent_required"
  return undefined
}

/** Resolve explicitly referenced connection credentials without provider preference/deduplication. */
export async function resolveCredentialReferencesForScope(
  references: Iterable<string>,
  scope: CredentialSecretScope,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const id of new Set(references)) {
    const row = ClaxedoDB.use((db) => db.select().from(ClaxedoProviderCredentialTable)
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id))).get())
    if (!row) continue
    const credential = toMetadata(row)
    if (!FANOUT_ELIGIBLE_KINDS.has(credential.kind) || !credentialAvailableForScope(credential, scope)) continue
    const secret = await getBackend().get(credential.secure_ref!)
    if (secret) result[id] = secret
  }
  return result
}
