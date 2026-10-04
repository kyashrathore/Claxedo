import type { ConnectionSecretAuthority } from "./connections"
import { isRecord } from "./values"

/**
 * What a harness receives in place of a credential.
 *
 * A bound row carries one binding's broker path, a signed capability for that
 * binding alone, and the mode naming the header the harness must carry it in.
 * The credential's own bytes stay with the authority that minted the binding
 * and never reach this process.
 *
 * An unavailable row says the operator selected an account for this provider
 * that cannot be bound. Without it a withdrawn account reaches a harness as an
 * absent projection, and the turn runs on whatever login the machine holds —
 * under an identity the operator did not choose.
 */
export type ProviderBinding = {
  baseUrl: string
  placeholder: string
  authMode: "api-key" | "bearer"
  /**
   * Absent when the placeholder has no lifetime of its own: a sandbox provider
   * that substitutes on egress holds the value until the authority withdraws
   * it, so there is no moment at which the harness must stop using it.
   */
  expiresAt?: number
  /**
   * Where the vendor's API root sits under `baseUrl`. A client that appends the
   * whole vendor path itself (Claude Code, the Cursor SDK) is configured with
   * `baseUrl`; one configured with an API root (Codex, Pi, the OpenCode engine)
   * appends this. Absent from an authority that does not model vendor paths,
   * which means `baseUrl` is already the root.
   */
  apiPath?: string
  /** The stored credential the placeholder spends, by its non-secret metadata, so a turn can say which account it ran on. */
  account?: BindingAccount
}

export type BindingAccount = { credentialId: string; providerId: string; label?: string }

export type ProviderUnavailable = {
  unavailable: true
  reason: string
}

/**
 * Whether a row is the refusal rather than a binding.
 *
 * Takes any object rather than a `ProviderProjection`, because the same
 * refusal travels alongside binding shapes this module does not own — the
 * engine's provider overlay carries `baseURL`/`apiKey` — and a second copy of
 * the predicate beside each of them is how two of them came to disagree.
 */
export function isProviderUnavailable(row: object): row is ProviderUnavailable {
  return "unavailable" in row
}

export type ProviderProjection = ProviderBinding | ProviderUnavailable

/**
 * What an authority puts on the wire, before the runtime resolves it.
 *
 * An authority that mints the placeholder itself sends it. One whose sandbox
 * provider issues the placeholder — the provider substitutes the value of an
 * env var it filled, and only the sandbox can read it — names that env var
 * instead, and `providerProjection` reads it off the runtime's own environment.
 * Exactly one of the two is a projection; both or neither is not.
 */
export type ProviderBindingSource =
  & Omit<ProviderBinding, "placeholder">
  & ({ placeholder: string; placeholderEnv?: undefined } | { placeholderEnv: string; placeholder?: undefined })

export type ProviderProjectionSource = ProviderBindingSource | ProviderUnavailable

/**
 * A credential handed to a harness that calls the vendor itself, in process,
 * with no broker between: the subscription providers that read the account
 * from the token, and a Durable Object host that has no egress broker.
 */
export type ProviderDirect = {
  delivery: "direct"
  baseUrl: string
  apiPath?: string
  secret: string
  authKind: "api-key" | "subscription"
  expiresAt?: number
  account?: BindingAccount
}

/**
 * A fresh copy of a direct credential, asked of the authority that handed it
 * over, under the proof of the turn that needs it; nothing when that authority
 * has no newer one to give or no turn is running.
 */
export type DirectCredentialRefresh = (input: {
  authority: ConnectionSecretAuthority
  credentialProviderId: string
  rejectedExpiresAt?: number
}) => Promise<ProviderDirect | undefined>

export function isProviderDirect(row: object): row is ProviderDirect {
  return "delivery" in row && row.delivery === "direct"
}

export type CredentialSnapshot<T = ProviderProjectionSource> = {
  machineOwnerUserId: string
  /**
   * The account each person spends, by user id and provider: their own, or the
   * org's account for a provider they chose it for. Nothing else is spent.
   */
  accounts: Record<string, Record<string, T>>
  direct?: Record<string, Record<string, ProviderDirect>>
}

/** The environment a `placeholderEnv` row is resolved against. */
export type PlaceholderEnvironment = Record<string, string | undefined>

const AUTH_MODES = ["api-key", "bearer"] as const
const DIRECT_AUTH_KINDS = ["api-key", "subscription"] as const
const BINDING_KEYS = new Set(["baseUrl", "placeholder", "placeholderEnv", "authMode", "expiresAt", "apiPath", "account"])
const DIRECT_KEYS = new Set(["delivery", "baseUrl", "apiPath", "secret", "authKind", "expiresAt", "account"])
const UNAVAILABLE_KEYS = new Set(["unavailable", "reason"])

export function providerProjection(
  input: unknown,
  env: PlaceholderEnvironment = {},
): ProviderProjection | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const row: Record<string, unknown> = { ...input }
  if ("unavailable" in row) {
    if (Object.keys(row).some((key) => !UNAVAILABLE_KEYS.has(key))) return undefined
    if (row.unavailable !== true || typeof row.reason !== "string" || !row.reason) return undefined
    return { unavailable: true, reason: row.reason }
  }
  if (Object.keys(row).some((key) => !BINDING_KEYS.has(key))) return undefined
  const { baseUrl, placeholderEnv } = row
  // `find` over the literal list yields the union member; a membership test
  // would leave a bare `string` and force an assertion.
  const authMode = AUTH_MODES.find((mode) => mode === row.authMode)
  if (typeof baseUrl !== "string" || !baseUrl || !authMode) return undefined
  const extras = bindingExtras(row)
  if (!extras) return undefined
  const rest = { baseUrl, authMode, ...extras }
  if (placeholderEnv !== undefined) {
    if (row.placeholder !== undefined || typeof placeholderEnv !== "string" || !placeholderEnv) return undefined
    const resolved = env[placeholderEnv]
    // Refused rather than dropped: a sandbox whose provider never filled the
    // variable has no credential at all, and an absent projection is what sends
    // the harness to the login its image carries.
    if (!resolved) return { unavailable: true, reason: `placeholder_env_missing: ${placeholderEnv}` }
    return { ...rest, placeholder: resolved }
  }
  const placeholder = row.placeholder
  if (typeof placeholder !== "string" || !placeholder) return undefined
  return { ...rest, placeholder }
}

export function providerDirect(input: unknown): ProviderDirect | undefined {
  if (!isRecord(input)) return undefined
  if (Object.keys(input).some((key) => !DIRECT_KEYS.has(key))) return undefined
  const { baseUrl, secret } = input
  const authKind = DIRECT_AUTH_KINDS.find((kind) => kind === input.authKind)
  if (input.delivery !== "direct" || typeof baseUrl !== "string" || !baseUrl || !authKind) return undefined
  // The secret becomes an HTTP header value; a line break in it would end the header.
  if (typeof secret !== "string" || !secret || /[\r\n]/.test(secret)) return undefined
  const extras = bindingExtras(input)
  if (!extras) return undefined
  return { delivery: "direct", baseUrl, secret, authKind, ...extras }
}

function bindingExtras(row: Record<string, unknown>): Pick<ProviderBinding, "expiresAt" | "apiPath" | "account"> | undefined {
  const { expiresAt, apiPath } = row
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) {
    return undefined
  }
  if (apiPath !== undefined && (typeof apiPath !== "string" || (apiPath && !apiPath.startsWith("/")))) return undefined
  const account = row.account === undefined ? undefined : bindingAccount(row.account)
  if (row.account !== undefined && !account) return undefined
  return {
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(apiPath === undefined ? {} : { apiPath }),
    ...(account ? { account } : {}),
  }
}

function bindingAccount(input: unknown): BindingAccount | undefined {
  if (!isRecord(input)) return undefined
  const { credentialId, providerId, label } = input
  if (typeof credentialId !== "string" || !credentialId || typeof providerId !== "string" || !providerId) return undefined
  if (label !== undefined && typeof label !== "string") return undefined
  return { credentialId, providerId, ...(label ? { label } : {}) }
}

/**
 * What a row this validator cannot read does to the whole record.
 *
 * `reject` is for a map that crossed a process boundary: a producer that sent a
 * row this runtime cannot read has said nothing trustworthy about the rest, so
 * the snapshot is refused whole and the one already applied stays. Only a
 * process projecting its own authority passes `unavailable`, where refusing
 * everything would disable every working account over one malformed row; that
 * row alone becomes an unavailable projection, which disables its provider and
 * refuses a turn on it rather than letting the harness fall back to a login the
 * operator did not choose.
 */
type ProviderProjectionRowPolicy = "reject" | "unavailable"

const UNRESOLVED_PROJECTION_REASON = "unresolved_projection"

export function credentialSnapshot(input: unknown, env: PlaceholderEnvironment): CredentialSnapshot<ProviderProjection> | undefined {
  if (!isRecord(input)) return undefined
  const row = input
  if (Object.keys(row).some((key) => key !== "machineOwnerUserId" && key !== "accounts" && key !== "direct")) return undefined
  if (typeof row.machineOwnerUserId !== "string") return undefined
  const accounts = perUser(row.accounts, (value) => providerProjectionRecord(value, env, { onInvalid: "reject" }))
  if (!accounts) return undefined
  if (row.direct === undefined) return { machineOwnerUserId: row.machineOwnerUserId, accounts }
  const direct = perUser(row.direct, providerDirectRecord)
  if (!direct) return undefined
  return { machineOwnerUserId: row.machineOwnerUserId, accounts, direct }
}

function perUser<T>(input: unknown, parse: (value: unknown) => T | undefined): Record<string, T> | undefined {
  if (!isRecord(input)) return undefined
  const rows: Record<string, T> = Object.create(null)
  for (const [userId, value] of Object.entries(input)) {
    const parsed = userId ? parse(value) : undefined
    if (!parsed) return undefined
    rows[userId] = parsed
  }
  return rows
}

function providerDirectRecord(input: unknown): Record<string, ProviderDirect> | undefined {
  if (!isRecord(input)) return undefined
  const rows: Record<string, ProviderDirect> = {}
  for (const [providerId, value] of Object.entries(input)) {
    const row = providerDirect(value)
    if (!row) return undefined
    rows[providerId] = row
  }
  return rows
}

export function providerProjectionRecord(
  input: unknown,
  env: PlaceholderEnvironment,
  options: { onInvalid: ProviderProjectionRowPolicy },
): Record<string, ProviderProjection> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const rows: Record<string, ProviderProjection> = {}
  for (const [providerId, value] of Object.entries(input)) {
    const projection = providerProjection(value, env)
    if (!projection) {
      if (options.onInvalid !== "unavailable") return undefined
      rows[providerId] = { unavailable: true, reason: UNRESOLVED_PROJECTION_REASON }
      continue
    }
    rows[providerId] = projection
  }
  return rows
}

/**
 * Whether a held projection is due for replacement. `all` is the caller saying
 * the process lost track of time — a laptop resumed from sleep reads a clock
 * later than any tick the timer saw — so nothing that expires may be trusted.
 */
export function projectionRenewalDue(input: { at: number; all?: boolean }, renewAt: number | undefined): boolean {
  return input.all === true || (renewAt !== undefined && renewAt <= input.at)
}

/**
 * When the earliest placeholder or direct credential in this map has to be
 * replaced: half of its own lifetime before it expires, so a turn that starts
 * just before renewal still finishes on a valid one.
 *
 * Read from `expiresAt` rather than from a fixed interval, because the lifetime
 * belongs to the authority that minted the placeholder and can be shorter than
 * any interval chosen here. A map carrying no row that expires never needs
 * renewing.
 */
export function projectionRenewalDueAt(
  auth: Record<string, ProviderProjection | ProviderDirect>,
  appliedAt: number,
): number | undefined {
  const due = Object.values(auth)
    .flatMap((row) => isProviderUnavailable(row) || row.expiresAt === undefined ? [] : [row.expiresAt])
    .map((expiresAt) => expiresAt - Math.max(expiresAt - appliedAt, 0) / 2)
  return due.length ? Math.min(...due) : undefined
}

/** The earliest renewal any row of a snapshot needs, across every person's accounts and direct credentials. */
export function credentialSnapshotRenewalDueAt(auth: CredentialSnapshot<ProviderProjection>, appliedAt: number): number | undefined {
  const due = [...Object.values(auth.accounts), ...Object.values(auth.direct ?? {})].flatMap((rows) => projectionRenewalDueAt(rows, appliedAt) ?? [])
  return due.length ? Math.min(...due) : undefined
}
