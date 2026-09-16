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
import { eq, and, asc, desc, inArray, sql } from "drizzle-orm"
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
  type CredentialUsageWindow,
  type CredentialWrite,
  type CredentialStatus,
  type SetActiveCredentialsResult,
} from "./types"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { credentialSecretInScope, type CredentialSecretScope } from "./secret-scope"
import { storedCredentialKind } from "./secret-material"
import { parseUsageWindows, serializeUsageWindows } from "./usage-windows"

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
 * What a read answers when the registry itself cannot be read. `"empty"` is
 * for a caller that can carry on without the row — a mutator that then reports
 * not-found, a sync that then imports afresh. `"throw"` is for a caller whose
 * empty answer already means something the outage does not: a catalog serving
 * "not connected", an authority withdrawing a binding, a fanout sending
 * nothing so the harness runs on the machine's own login.
 */
export type RegistryOutage = "throw" | "empty"

export type CredentialRead = { onOutage: RegistryOutage }

function readWithPolicy<T>(label: string, onOutage: RegistryOutage, empty: T, read: () => T): T {
  return onOutage === "throw" ? read() : safeRead(label, empty, read)
}

/**
 * The identity a pasted key carries when the provider gives none.
 *
 * The upsert key includes `account_id`, so two keys saved without one are the
 * same row: hashing the secret makes them two rows, and the same key saved
 * twice idempotent. The trailing characters are the ones the provider's own
 * dashboard shows, so the row is recognisable in the accounts list without ever
 * revealing the key.
 *
 * Keyed on the caller's kind rather than the stored one: a pasted setup token
 * settles under `oauth_token` and still names no account. Logins that arrive
 * from an OAuth flow carry the provider's account id already, and everything
 * that is not harness auth (sandbox drivers, `integration:` and `channel:`
 * secrets) has one row per provider by design.
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

  // The fingerprint keys on what the caller pasted, so the same token pasted
  // twice stays one row whichever kind it settles under.
  const accountId = input.account_id ?? pastedAccountId(input)
  const kind = storedCredentialKind(input)

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
          eq(ClaxedoProviderCredentialTable.kind, kind),
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
  const replacing = exclusiveAuthKinds.some((exclusive) => exclusive === kind)
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
    kind,
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
    revision: (existing?.revision ?? 0) + 1,
    // Cleared for the same reason as `health`: a re-saved credential has not
    // been put to its provider yet, and the last read's percentages describe a
    // check that no longer stands.
    usage_windows: null,
    usage_at: null,
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
    const active = fanoutEligibleAuth(kind, input.provider_id) && !usable
    const row = { ...fields, is_active: active, activated_at: active ? ts : null }
    if (row.is_active && holders.length > 0) {
      db.update(ClaxedoProviderCredentialTable)
        .set({ is_active: false, activated_at: null, updated_at: ts })
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

  log.info("Credential stored", { id, org_id: orgId, provider_id: input.provider_id, kind })

  return toMetadata(stored)
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
  return { ...row, consent: readConsent(row.consent_json), usage_windows: parseUsageWindows(row.usage_windows) }
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
 * choice a surface can show and the only one they can change, and the most
 * recent mark leads. Below the mark the most recent write wins, which decides
 * only between rows that never carry one: sandbox driver tokens and
 * `integration:`/`channel:` secrets, of which a provider holds a single row per
 * kind.
 */
const activeFirst = [
  desc(ClaxedoProviderCredentialTable.is_active),
  desc(ClaxedoProviderCredentialTable.activated_at),
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
        .set({ is_active: false, activated_at: null, updated_at: ts })
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
        .set({ is_active: true, activated_at: ts, updated_at: ts })
        .where(and(inOrg(orgId), eq(ClaxedoProviderCredentialTable.id, row.id)))
        .run()
    }
    return {
      ok: true,
      credentials: rows.map((row) => toMetadata({ ...row, is_active: true, activated_at: ts, updated_at: ts })),
    }
  })
}

/**
 * Leave a provider with no marked account, so its harness runs on the login its
 * own CLI holds on this machine.
 *
 * The implicit tier is the absence of a mark, not a row of its own, so
 * "use this computer's login" is exactly this clear — one transaction over the
 * same partitions `setActiveCredentials` writes, for the same reason: a caller
 * must never see the mark gone from one binding of a harness and standing on
 * another.
 */
export function clearActiveCredentials(
  providerIds: readonly string[],
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): { cleared: string[] } {
  const orgId = credentialOrg(org)
  return ClaxedoDB.transaction((db) => {
    const cleared: string[] = []
    for (const providerId of providerIds) {
      const rows = db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(
          and(
            inOrg(orgId),
            eq(ClaxedoProviderCredentialTable.provider_id, providerId),
            eq(ClaxedoProviderCredentialTable.is_active, true),
          ),
        )
        .all()
      if (rows.length === 0) continue
      db.update(ClaxedoProviderCredentialTable)
        .set({ is_active: false, activated_at: null, updated_at: now() })
        .where(
          and(
            inOrg(orgId),
            eq(ClaxedoProviderCredentialTable.provider_id, providerId),
            eq(ClaxedoProviderCredentialTable.is_active, true),
          ),
        )
        .run()
      cleared.push(...rows.map((row) => row.id))
    }
    return { cleared }
  })
}

/**
 * `provider_id` is NOT unique — `putCredential` upserts on (org, provider_id,
 * kind, account_id) — and several sandbox driver ids collide with
 * model-provider ids (`vercel` is both). Without `kind` the read answers
 * whichever row sorts first, which for a sandbox lookup can be the user's
 * model-provider API key and for a model lookup a stored deploy token.
 */
export type ProviderCredentialRead = CredentialRead & {
  kind?: CredentialKind | readonly CredentialKind[] | undefined
}

function readRow(label: string, onOutage: RegistryOutage, read: () => CredentialRow | undefined) {
  const row = readWithPolicy(label, onOutage, undefined, read)
  return row ? toMetadata(row) : undefined
}

/** One provider's credential in one org, the marked account first. */
export function credentialByProvider(
  providerId: string,
  { onOutage, kind }: ProviderCredentialRead,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): CredentialMetadata | undefined {
  const kinds = kind === undefined ? undefined : typeof kind === "string" ? [kind] : [...kind]
  return readRow("credential lookup", onOutage, () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(
          and(
            inOrg(org),
            eq(ClaxedoProviderCredentialTable.provider_id, providerId),
            kinds && inArray(ClaxedoProviderCredentialTable.kind, kinds),
          ),
        )
        .orderBy(...activeFirst)
        .get(),
    ),
  )
}

/** Credential metadata by id, within one org. */
export function credentialById(
  id: string,
  { onOutage }: CredentialRead,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): CredentialMetadata | undefined {
  return readRow("credential read", onOutage, () =>
    ClaxedoDB.use((db) =>
      db
        .select()
        .from(ClaxedoProviderCredentialTable)
        .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
        .get(),
    ),
  )
}

/** Resolve a credential's raw secret material — only call at trusted fanout points. */
export async function resolveSecret(
  providerId: string,
  kind?: CredentialKind,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<string | null> {
  const cred = credentialByProvider(providerId, { onOutage: "empty", kind }, org)
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
  const cred = credentialById(id, { onOutage: "empty" }, org)
  if (!cred?.secure_ref) return null
  const secret = await getBackend().get(cred.secure_ref)
  if (secret) touchCredential(cred.id, org)
  return secret
}

/**
 * The stored secret without recording a use.
 *
 * The broker reads one per proxied request, and a write per request turns a
 * streaming turn into a stream of registry writes. Its caller marks the use on
 * its own schedule instead.
 */
export async function readSecretById(
  id: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<string | null> {
  const cred = credentialById(id, { onOutage: "throw" }, org)
  if (!cred?.secure_ref) return null
  return await getBackend().get(cred.secure_ref)
}

/** Record that a credential was spent at `at`, for a caller that owns the schedule. */
export function markCredentialUsed(id: string, at: number, org?: CredentialOrgScope) {
  ClaxedoDB.use((db) => db
    .update(ClaxedoProviderCredentialTable)
    .set({ last_used_at: at })
    .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
    .run())
}

function touchCredential(id: string, org?: CredentialOrgScope) {
  markCredentialUsed(id, now(), org)
}

/**
 * Replace stored secret material in place, keeping the credential's identity,
 * scope, and consent. Used when an OAuth credential is renewed during
 * verification, and when a user reconnects an account by hand — `putCredential`
 * would be the wrong tool: it re-runs the exclusive-kind replacement logic for
 * what is the same login.
 *
 * The stored verdict was reached against the secret being replaced, so it
 * cannot survive the swap: the row is unchecked until something checks the new
 * material. A caller that already knows the renewed secret works writes its own
 * verdict after this returns.
 */
export async function updateCredentialSecret(
  id: string,
  secret: string,
  expiresAt?: number | null,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<boolean> {
  const credential = credentialById(id, { onOutage: "empty" }, org)
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
      kind: storedCredentialKind({ kind: credential.kind, secret }),
      // `null` is a caller saying the replacement has no expiry, which is a
      // different fact from not knowing one: the stored expiry described the
      // material being replaced, so carrying it over expires a live secret.
      expires_at: expiresAt === undefined ? credential.expires_at ?? null : expiresAt,
      updated_at: now(),
      revision: credential.revision + 1,
      health: null,
      last_validated_at: null,
      last_error: null,
      status: "available",
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
  const credential = credentialById(id, { onOutage: "empty" }, org)
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

/**
 * Rename a credential. The name is the only thing that changes: the secret a
 * binding resolves is the same one, so `revision` stays put and a holder of the
 * old revision is not superseded, and the stored verdict still describes the
 * material it was reached against.
 */
export function updateCredentialLabel(
  id: string,
  label: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): boolean {
  const credential = credentialById(id, { onOutage: "empty" }, org)
  if (!credential) return false
  ClaxedoDB.use((db) => db
    .update(ClaxedoProviderCredentialTable)
    .set({
      label,
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

/**
 * The verdicts that end an account's turn as the one its provider runs on.
 *
 * A rate cap is not one of them: the same login works again once the window
 * resets, and moving off it would spend the next account's quota for nothing.
 */
const YIELDS_ACTIVE_MARK: readonly CredentialHealth[] = ["auth_failed", "no_billing", "expired"]

/**
 * Persist the provider-backed health result consumed by every credential
 * surface, and hand the mark on when that result ends the account.
 *
 * Every refusal reaches here — the operator's Check and the broker's
 * `reportFailure` both land on this one write — so the move belongs here rather
 * than at either caller. The mark goes to the oldest account the provider can
 * still run on, the same heir `deleteCredential` promotes; with no such account
 * the refused row KEEPS the mark, because clearing it would silently drop the
 * user onto the machine's own CLI login, which is only ever an explicit choice.
 */
export function updateCredentialHealth(
  id: string,
  health: CredentialHealth,
  validatedAt: number,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): void {
  ClaxedoDB.transaction((db) => {
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
      .run()
    if (!YIELDS_ACTIVE_MARK.includes(health)) return
    const refused = db
      .select()
      .from(ClaxedoProviderCredentialTable)
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
      .get()
    if (!refused?.is_active) return
    const partition = { provider_id: refused.provider_id, owner: refused.owner ?? null }
    const heir = oldestAvailable(db, org, partition)
    if (!heir) return
    db.update(ClaxedoProviderCredentialTable)
      .set({ is_active: false, activated_at: null, updated_at: now() })
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
      .run()
    markActive(db, org, heir.id)
    log.info("Active credential yielded to the next account", {
      credential_id: id,
      provider_id: refused.provider_id,
      health,
      marked_active: heir.id,
    })
  })
}

/**
 * Persist how much of the plan the last usage read found spent.
 *
 * Deliberately leaves `updated_at` alone. That column breaks ties between two
 * accounts of one provider, and a quota read says nothing about which account
 * the user wants run — touching it would let a Check reorder the fanout.
 */
export function updateCredentialUsage(
  id: string,
  windows: readonly CredentialUsageWindow[],
  at: number,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): void {
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoProviderCredentialTable)
      .set({ usage_windows: serializeUsageWindows(windows), usage_at: at })
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
      .run(),
  )
}

/**
 * Hand the mark to the oldest account the provider can still run on.
 *
 * Removing the marked account otherwise leaves the partition unmarked: the
 * fanout sends nothing and the harness falls back to the machine login while
 * a working account sits in the list. Same shape as the save-time yield —
 * only an `available` row qualifies, and only auth the fanout may carry,
 * which is the only kind the mark is ever set on.
 *
 * Runs inside the delete's own transaction: the partial unique index refuses
 * to see two marks in one partition. Two accounts saved in the same
 * millisecond share `created_at`, so insertion order decides between them and
 * the same account is promoted on every machine.
 */
function oldestAvailable(
  db: ClaxedoDB.Client,
  org: CredentialOrgScope,
  partition: { provider_id: string; owner: string | null },
) {
  return db
    .select()
    .from(ClaxedoProviderCredentialTable)
    .where(
      and(
        inOrg(org),
        eq(ClaxedoProviderCredentialTable.provider_id, partition.provider_id),
        ownedBy(partition.owner),
        eq(ClaxedoProviderCredentialTable.status, "available"),
      ),
    )
    .orderBy(asc(ClaxedoProviderCredentialTable.created_at), sql`rowid`)
    .all()
    .find((candidate) => fanoutEligible(toMetadata(candidate)))
}

function markActive(db: ClaxedoDB.Client, org: CredentialOrgScope, id: string) {
  db.update(ClaxedoProviderCredentialTable)
    .set({ is_active: true, activated_at: now(), updated_at: now() })
    .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
    .run()
}

function markOldestAvailable(
  db: ClaxedoDB.Client,
  org: CredentialOrgScope,
  partition: { provider_id: string; owner: string | null },
) {
  const heir = oldestAvailable(db, org, partition)
  if (!heir) return undefined
  markActive(db, org, heir.id)
  return heir.id
}

/** Delete a credential and its backend secret. */
export async function deleteCredential(
  id: string,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<boolean> {
  const cred = credentialById(id, { onOutage: "empty" }, org)
  if (!cred) return false

  if (cred.secure_ref) {
    const backend = getBackend()
    await backend.delete(cred.secure_ref).catch((err) => {
      log.warn("Failed to delete backend secret", { id, error: String(err) })
    })
  }

  const marked = ClaxedoDB.transaction((db) => {
    db.delete(ClaxedoProviderCredentialTable)
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.id, id)))
      .run()
    return cred.is_active === true ? markOldestAvailable(db, org, { provider_id: cred.provider_id, owner: cred.owner ?? null }) : undefined
  })

  log.info("Credential deleted", {
    id,
    org_id: credentialOrg(org),
    provider_id: cred.provider_id,
    ...(marked === undefined ? {} : { marked_active: marked }),
  })

  return true
}

/**
 * Delete every credential for a provider in one org, optionally scoped to one
 * `kind`.
 *
 * Unscoped by kind this is destructive across features: `vercel` is both a
 * sandbox driver id and a model-provider id, so "Remove" in Sandbox settings
 * takes the user's Vercel model API key with it. Pass `kind` whenever the
 * caller owns only one kind of credential. The ORG scope is not optional — it is what keeps one tenant's
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
export const PROVIDER_AUTH_KINDS = ["api_key", "oauth_token", "subscription_session"] as const satisfies readonly CredentialKind[]
const FANOUT_ELIGIBLE_KINDS = new Set<CredentialKind>(PROVIDER_AUTH_KINDS)

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
function readActiveCredentials(org: CredentialOrgScope): CredentialMetadata[] {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoProviderCredentialTable)
      .where(and(inOrg(org), eq(ClaxedoProviderCredentialTable.is_active, true)))
      .all()
      .map(toMetadata),
  )
}

export type ScopedCredentialSelection = {
  credential: CredentialMetadata
  /** Absent when the account can be used; otherwise why it cannot. */
  unavailable?: string
}

/**
 * Every account the operator marked for a provider in this scope, usable or
 * not, without secrets. This is the only place "which credential runs" is
 * answered, so a surface that shows it reads the same selection.
 *
 * The scope filter runs after the mark, not instead of it: a user whose active
 * account is not shared sends nothing into a sandbox even when another of their
 * accounts would qualify, because silently running a sandbox on an account the
 * user did not choose is the thing the mark exists to stop.
 *
 * A withdrawn row stays in the answer with its reason. Dropping it would make
 * "no account chosen" and "the chosen account is unusable" indistinguishable,
 * and the harness then runs on whatever login its machine holds. A caller that
 * can only consume a working credential passes the answer through
 * `usableCredentials`.
 */
export function activeCredentialsForScope(
  scope: CredentialSecretScope,
  { onOutage }: CredentialRead,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): ScopedCredentialSelection[] {
  return readWithPolicy("active credential list", onOutage, [], () => readActiveCredentials(org))
    .filter((credential) => fanoutEligible(credential) && credentialSecretInScope(credential, scope))
    .map((credential) => {
      const unavailable = credentialUnavailableForScope(credential, scope)
      return unavailable ? { credential, unavailable } : { credential }
    })
}

/** The rows of a selection the fanout can send, one per provider. */
export function usableCredentials(rows: readonly ScopedCredentialSelection[]): CredentialMetadata[] {
  return rows.flatMap((row) => (row.unavailable ? [] : [row.credential]))
}

/**
 * Why an in-scope account cannot be used, or `undefined` when it can. The
 * health is preferred over the status because a health verdict names what the
 * provider said (`auth_failed`, `no_billing`) where the status only records
 * that something went wrong.
 */
export function credentialUnavailableForScope(
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

