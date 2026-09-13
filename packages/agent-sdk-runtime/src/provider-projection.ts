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

export class ProviderCredentialUnavailableError extends Error {
  constructor(readonly harnessId: string, readonly reason: string) {
    super(`the account selected for ${harnessId} cannot be used: ${reason}`)
    this.name = "ProviderCredentialUnavailableError"
  }
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
