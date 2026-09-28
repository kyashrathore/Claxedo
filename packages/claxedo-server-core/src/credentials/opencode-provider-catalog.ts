import { vendorCredentialProviderIds } from "@claxedo/agent-runtime-contract"
import type { ProviderCatalogEntry, ProviderModel } from "@claxedo/harness/contract"
import { listCustomProviders, type CustomProviderConfig } from "./custom-provider"
import { listCredentials, PROVIDER_AUTH_KINDS, type CredentialOrgScope } from "./registry"
import type { CredentialMetadata } from "./types"
import { VENDOR_PROVIDER_NAMES } from "./vendor-providers"

export type OpenCodeCatalogModel = {
  id: string
  name: string
  /** The engine's effort variants for this model, keyed by id; absent when it applies none. */
  variants?: Record<string, Record<string, never>>
  /** Whether the engine can run a turn on this model now. */
  connected: boolean
  /** Whether the engine prices every tier of this model at zero. */
  free: boolean
}

export type OpenCodeCatalogProvider = {
  id: string
  name: string
  env: string[]
  /** `custom` for an operator-declared provider, `api` for one the org stored an account for, `config` otherwise. */
  source: "custom" | "api" | "config"
  models: Record<string, OpenCodeCatalogModel>
  /** Present on operator-declared providers: `baseURL` and non-secret headers. */
  options?: Record<string, unknown>
}

export type OpenCodeCatalog = {
  all: OpenCodeCatalogProvider[]
  connected: string[]
  default: Record<string, string>
}

function catalogModel(model: ProviderModel, connected: boolean): OpenCodeCatalogModel {
  return {
    id: model.id, name: model.name ?? model.id, connected,
    free: model.cost.length > 0 && model.cost.every((tier) => tier.input === 0 && tier.output === 0),
    ...(model.variants?.length ? { variants: Object.fromEntries(model.variants.map((id) => [id, {}])) } : {}),
  }
}

function providerModels(provider: CustomProviderConfig): ProviderModel[] {
  return Object.entries(provider.models).map(([id, model]) => ({ providerID: provider.providerID, id, name: model.name, cost: [] }))
}

/**
 * With no workspace engine to ask — none is named yet, as in onboarding, or
 * its cloud sandbox is not running — the credential registry answers: the
 * vendors it brokers to, connected where the org holds an available account,
 * and the org's declared providers, connected unless every account stored
 * for them is refused. No models are listed for a vendor, because only an
 * engine knows which it can run.
 */
function accountEntries(declared: ReadonlyMap<string, CustomProviderConfig>, credentials: readonly CredentialMetadata[]): ProviderCatalogEntry[] {
  const accounts = credentials.filter((credential) => (PROVIDER_AUTH_KINDS as readonly string[]).includes(credential.kind))
  const available = (ids: readonly string[]) => accounts.some((credential) => ids.includes(credential.provider_id) && credential.status === "available")
  const vendors = Object.entries(VENDOR_PROVIDER_NAMES).map(([id, name]): ProviderCatalogEntry => ({
    id, name, env: [], connected: available(vendorCredentialProviderIds(id)), models: [],
  }))
  const custom = [...declared.values()].map((provider): ProviderCatalogEntry => ({
    id: provider.providerID, name: provider.name, env: provider.env, models: providerModels(provider),
    connected: available([provider.providerID]) || !accounts.some((credential) => credential.provider_id === provider.providerID),
  }))
  return [...vendors.filter((vendor) => !declared.has(vendor.id)), ...custom]
}

/**
 * The Settings catalog: what the workspace engine discovers and can run,
 * joined with what this org manages for each provider. A declared provider the
 * engine disabled, and a vendor whose stored account it refused, stay listed
 * disconnected, so Settings still offers their reconnect and disconnect rows.
 */
export function opencodeProviderCatalog(options: {
  engine: readonly ProviderCatalogEntry[] | undefined
  org: CredentialOrgScope
}): OpenCodeCatalog {
  const declared = new Map(listCustomProviders(options.org).map((provider) => [provider.providerID, provider]))
  const credentials = listCredentials(options.org)
  const entries = new Map((options.engine ?? accountEntries(declared, credentials)).map((entry) => [entry.id, entry]))
  const stored = new Set(credentials
    .filter((credential) => (PROVIDER_AUTH_KINDS as readonly string[]).includes(credential.kind))
    .map((credential) => credential.provider_id))
  for (const provider of declared.values()) {
    if (entries.has(provider.providerID)) continue
    entries.set(provider.providerID, { id: provider.providerID, name: provider.name, env: provider.env, connected: false, models: providerModels(provider) })
  }
  const all = [...entries.values()].map((entry): OpenCodeCatalogProvider => {
    const custom = declared.get(entry.id)
    return {
      id: entry.id,
      name: custom?.name ?? entry.name,
      env: [...(custom?.env ?? entry.env)],
      source: custom ? "custom" : vendorCredentialProviderIds(entry.id).some((id) => stored.has(id)) ? "api" : "config",
      models: Object.fromEntries(entry.models.map((model) => [model.id, catalogModel(model, entry.connected)])),
      ...(custom ? { options: { baseURL: custom.baseURL, ...(Object.keys(custom.headers).length ? { headers: custom.headers } : {}) } } : {}),
    }
  })
  const defaults = all.flatMap((provider) => {
    const first = Object.keys(provider.models).sort()[0]
    return first ? [[provider.id, first] as const] : []
  })
  return { all, connected: [...entries.values()].filter((entry) => entry.connected).map((entry) => entry.id), default: Object.fromEntries(defaults) }
}
