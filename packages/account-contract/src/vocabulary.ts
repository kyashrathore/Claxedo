/** Whose stored account a person spends for a provider: their own, or the org's row. */
export const ACCOUNT_SOURCES = ["own", "org"] as const
export type AccountSource = (typeof ACCOUNT_SOURCES)[number]

export function isAccountSource(value: unknown): value is AccountSource {
  return ACCOUNT_SOURCES.some((source) => source === value)
}

/** Where a stored account's secret may be delivered: this machine only, or also to cloud sandboxes. */
export const ACCOUNT_SCOPES = ["local", "shared"] as const
export type AccountScope = (typeof ACCOUNT_SCOPES)[number]

export function isAccountScope(value: unknown): value is AccountScope {
  return ACCOUNT_SCOPES.some((scope) => scope === value)
}
