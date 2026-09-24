import type { Account } from "../account-types"

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export function accountFromWire(value: unknown): Account | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  const id = text(row.id)
  const providerId = text(row.provider_id)
  if (!id || !providerId) return undefined
  const label = text(row.label)
  const accountId = text(row.account_id)
  const status = text(row.status)
  const health = text(row.health)
  return {
    id,
    providerId,
    kind: text(row.kind) ?? "unknown",
    source: text(row.source) ?? "unknown",
    ...(label ? { label } : {}),
    ...(accountId ? { accountId } : {}),
    active: row.is_active === true,
    ...(status ? { status } : {}),
    ...(health ? { health } : {}),
    hasSecret: row.has_secret === true,
    ...(typeof row.expires_at === "number" ? { expiresAt: row.expires_at } : {}),
    scope: text(row.scope) ?? "local",
  }
}
