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
  expiresAt: number
  /**
   * Where the vendor's API root sits under `baseUrl`. A client that appends the
   * whole vendor path itself (Claude Code, the Cursor SDK) is configured with
   * `baseUrl`; one configured with an API root (Codex, Pi, the OpenCode engine)
   * appends this. Absent from an authority that does not model vendor paths,
   * which means `baseUrl` is already the root.
   */
  apiPath?: string
}

export type ProviderUnavailable = {
  unavailable: true
  reason: string
}

export type ProviderProjection = ProviderBinding | ProviderUnavailable

const AUTH_MODES = ["api-key", "bearer"] as const
const BINDING_KEYS = new Set(["baseUrl", "placeholder", "authMode", "expiresAt", "apiPath"])
const UNAVAILABLE_KEYS = new Set(["unavailable", "reason"])

export function isProviderUnavailable(projection: ProviderProjection): projection is ProviderUnavailable {
  return "unavailable" in projection
}

export function providerProjection(input: unknown): ProviderProjection | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const row: Record<string, unknown> = { ...input }
  if ("unavailable" in row) {
    if (Object.keys(row).some((key) => !UNAVAILABLE_KEYS.has(key))) return undefined
    if (row.unavailable !== true || typeof row.reason !== "string" || !row.reason) return undefined
    return { unavailable: true, reason: row.reason }
  }
  if (Object.keys(row).some((key) => !BINDING_KEYS.has(key))) return undefined
  const { baseUrl, placeholder, expiresAt } = row
  // `find` over the literal list yields the union member; a membership test
  // would leave a bare `string` and force an assertion.
  const authMode = AUTH_MODES.find((mode) => mode === row.authMode)
  if (typeof baseUrl !== "string" || !baseUrl || typeof placeholder !== "string" || !placeholder) return undefined
  if (!authMode || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return undefined
  const apiPath = row.apiPath
  if (apiPath !== undefined && (typeof apiPath !== "string" || (apiPath && !apiPath.startsWith("/")))) return undefined
  return { baseUrl, placeholder, authMode, expiresAt, ...(apiPath === undefined ? {} : { apiPath }) }
}

export function providerProjectionRecord(input: unknown): Record<string, ProviderProjection> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const rows: Record<string, ProviderProjection> = {}
  for (const [providerId, value] of Object.entries(input)) {
    const projection = providerProjection(value)
    if (!projection) return undefined
    rows[providerId] = projection
  }
  return rows
}

/**
 * When the earliest placeholder in this map has to be replaced: half of its own
 * lifetime before it expires, so a turn that starts just before renewal still
 * finishes on a valid one.
 *
 * Read from `expiresAt` rather than from a fixed interval, because the lifetime
 * belongs to the authority that minted the placeholder and can be shorter than
 * any interval chosen here. A map carrying no bound row never needs renewing.
 */
export function projectionRenewalDueAt(
  auth: Record<string, ProviderProjection>,
  appliedAt: number,
): number | undefined {
  const due = Object.values(auth)
    .filter((row): row is ProviderBinding => !isProviderUnavailable(row))
    .map((row) => row.expiresAt - Math.max(row.expiresAt - appliedAt, 0) / 2)
  return due.length ? Math.min(...due) : undefined
}

export class ProviderCredentialUnavailableError extends Error {
  /**
   * The word "credential" is in the message because the turn-outcome classifier
   * reads the message rather than the error: without it the operator is shown a
   * generic failure for the one problem they can actually fix.
   */
  constructor(readonly harnessId: string, readonly reason: string) {
    super(`the ${harnessId} credential selected for this workspace cannot be used: ${reason}`)
    this.name = "ProviderCredentialUnavailableError"
  }
}

/**
 * A placeholder whose lifetime ran out before the harness was spawned.
 *
 * Named rather than left to the vendor's 401: an expired placeholder reaches
 * the vendor as an ordinary bad token, and attributing that to the operator's
 * account is how a working credential gets marked broken. The word
 * "credential" is in the message for the same reason it is in
 * `ProviderCredentialUnavailableError`.
 */
export class ProviderProjectionExpiredError extends Error {
  constructor(readonly harnessId: string, readonly expiresAt: number) {
    super(`the ${harnessId} credential binding expired at ${new Date(expiresAt).toISOString()} and was not renewed`)
    this.name = "ProviderProjectionExpiredError"
  }
}

/**
 * The binding to launch on, refusing one whose lifetime has already run out.
 * A driver that spawned on an expired placeholder would turn a renewal that
 * did not happen into a vendor authentication failure.
 *
 * Renewal itself belongs to the host that minted the projection and pushes a
 * replacement through `applyConfig`; a launch reads what is held and refuses,
 * because a push into an adapter mid-turn is deferred to the turn boundary and
 * so cannot answer a request made from inside a launch.
 */
export function liveProviderBinding(
  harnessId: string,
  projection: ProviderProjection | undefined,
  now: () => number = Date.now,
): ProviderBinding | undefined {
  const held = providerBinding(harnessId, projection)
  if (!held) return undefined
  if (held.expiresAt <= now()) throw new ProviderProjectionExpiredError(harnessId, held.expiresAt)
  return held
}

/**
 * The binding a harness may launch on, or nothing when no account is selected
 * for this provider. Every driver reads its projection through this rather than
 * off the field, so a selected-but-unusable account stops the launch here
 * instead of reaching the implicit tier as an absent projection.
 */
export function providerBinding(
  harnessId: string,
  projection: ProviderProjection | undefined,
): ProviderBinding | undefined {
  if (!projection) return undefined
  if (isProviderUnavailable(projection)) throw new ProviderCredentialUnavailableError(harnessId, projection.reason)
  return projection
}

/**
 * Change identity for a held projection. Renewal keeps the binding and replaces
 * the placeholder, so equality has to read the placeholder rather than the
 * object reference or the harness would keep spawning on an expired one.
 */
export function providerProjectionKey(projection: ProviderProjection | undefined) {
  if (!projection) return ""
  if (isProviderUnavailable(projection)) return `unavailable\n${projection.reason}`
  return `${projection.baseUrl}${projection.apiPath ?? ""}\n${projection.placeholder}\n${projection.authMode}`
}
