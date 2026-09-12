/**
 * What a harness receives in place of a credential.
 *
 * The endpoint is one binding's broker path, the placeholder is a signed
 * capability for that binding alone, and the mode names the header the harness
 * must carry it in. The credential's own bytes stay with the authority that
 * minted the binding and never reach this process.
 */
export type ProviderProjection = {
  baseUrl: string
  placeholder: string
  authMode: "api-key" | "bearer"
  expiresAt: number
}

const AUTH_MODES = ["api-key", "bearer"] as const
const PROJECTION_KEYS = new Set(["baseUrl", "placeholder", "authMode", "expiresAt"])

export function providerProjection(input: unknown): ProviderProjection | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const row: Record<string, unknown> = { ...input }
  if (Object.keys(row).some((key) => !PROJECTION_KEYS.has(key))) return undefined
  const { baseUrl, placeholder, expiresAt } = row
  // `find` over the literal list yields the union member; a membership test
  // would leave a bare `string` and force an assertion.
  const authMode = AUTH_MODES.find((mode) => mode === row.authMode)
  if (typeof baseUrl !== "string" || !baseUrl || typeof placeholder !== "string" || !placeholder) return undefined
  if (!authMode || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return undefined
  return { baseUrl, placeholder, authMode, expiresAt }
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

export class ProviderProjectionUnsupportedError extends Error {
  constructor(readonly harnessId: string) {
    super(`provider projection not supported by this harness yet: ${harnessId}`)
    this.name = "ProviderProjectionUnsupportedError"
  }
}

/**
 * The one line every harness that cannot yet read a projection owes its caller.
 * Without it a configured account reaches such a harness as a shape it ignores,
 * and the turn runs on whatever ambient login the machine happens to hold.
 */
export function assertNoProviderProjection(harnessId: string, auth: unknown) {
  if (auth === undefined || auth === null) return
  if (typeof auth !== "object") throw new ProviderProjectionUnsupportedError(harnessId)
  const values: unknown[] = Object.values(auth)
  if (values.some((value) => value !== undefined)) throw new ProviderProjectionUnsupportedError(harnessId)
}

/**
 * Change identity for a held projection. Renewal keeps the binding and replaces
 * the placeholder, so equality has to read the placeholder rather than the
 * object reference or the harness would keep spawning on an expired one.
 */
export function providerProjectionKey(projection: ProviderProjection | undefined) {
  return projection ? `${projection.baseUrl}\n${projection.placeholder}\n${projection.authMode}` : ""
}
