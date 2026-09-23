import { queryOptions } from "@tanstack/solid-query"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"

export type Account = {
  readonly id: string
  readonly providerId: string
  readonly kind: string
  readonly source: string
  readonly label?: string
  readonly accountId?: string
  readonly active: boolean
  readonly status?: string
  readonly health?: string
  readonly hasSecret: boolean
  readonly expiresAt?: number
  readonly scope: string
}

export type ProviderModel = {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly family?: string
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly connected: boolean
  readonly free: boolean
  readonly variants?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly limit: { readonly context: number; readonly output: number; readonly input?: number }
}

export type Provider = {
  readonly id: string
  readonly name: string
  readonly source: "env" | "config" | "custom" | "api"
  readonly models: Readonly<Record<string, ProviderModel>>
}

export type ProviderList = {
  readonly all: readonly Provider[]
  readonly default: Readonly<Record<string, string>>
  readonly connected: readonly string[]
}

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

function isProviderList(value: unknown): value is ProviderList {
  const row = value as Partial<ProviderList> | null
  return !!row && Array.isArray(row.all) && Array.isArray(row.connected) && !!row.default && typeof row.default === "object"
}

export async function listProviders(transport: Transport, harness: string): Promise<ProviderList> {
  const body = await transport.json<unknown>(withQuery("/api/claxedo/agent-config/providers", { nativeHarness: harness }))
  return isProviderList(body) ? body : { all: [], default: {}, connected: [] }
}

export function accountQueries(transport: Transport) {
  return {
    list: () => queryOptions({
      queryKey: queryKeys.accounts(transport.serverUrl),
      queryFn: async () => {
        const body = await transport.json<{ credentials?: unknown }>("/api/claxedo/credentials")
        return (Array.isArray(body.credentials) ? body.credentials : []).flatMap((row) => {
          const account = accountFromWire(row)
          return account ? [account] : []
        })
      },
    }),
    providers: (harness: string) => queryOptions({
      queryKey: queryKeys.providers(transport.serverUrl, harness),
      queryFn: () => listProviders(transport, harness),
    }),
  }
}
