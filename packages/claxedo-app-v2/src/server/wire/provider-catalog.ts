import { isRecord } from "@claxedo/helpers/guards"
import { ServerError } from "../errors"

export type CatalogModel = {
  readonly id: string
  readonly name: string
  readonly connected?: boolean
  readonly free?: boolean
  readonly variants?: Readonly<Record<string, unknown>>
}

export type ProviderSource = "env" | "api" | "config" | "custom"

export type CatalogProvider = {
  readonly id: string
  readonly name: string
  readonly source?: ProviderSource
  readonly models: Readonly<Record<string, CatalogModel>>
}

const PROVIDER_SOURCES: readonly string[] = ["env", "api", "config", "custom"] satisfies readonly ProviderSource[]

function isProviderSource(value: unknown): value is ProviderSource {
  return typeof value === "string" && PROVIDER_SOURCES.includes(value)
}

export type ProviderCatalog = {
  readonly all: readonly CatalogProvider[]
  readonly connected: readonly string[]
  readonly default: Readonly<Record<string, string>>
}

function modelOf(key: string, value: unknown): CatalogModel | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === "string" ? value.id : key
  return {
    id,
    name: typeof value.name === "string" ? value.name : id,
    ...(typeof value.connected === "boolean" ? { connected: value.connected } : {}),
    ...(typeof value.free === "boolean" ? { free: value.free } : {}),
    ...(isRecord(value.variants) ? { variants: value.variants } : {}),
  }
}

function providerOf(value: unknown): CatalogProvider | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.models)) return undefined
  const models: Record<string, CatalogModel> = {}
  for (const [key, entry] of Object.entries(value.models)) {
    const model = modelOf(key, entry)
    if (model) models[key] = model
  }
  return { id: value.id, name: typeof value.name === "string" ? value.name : value.id, ...(isProviderSource(value.source) ? { source: value.source } : {}), models }
}

export function providerCatalogFromWire(body: unknown, harness: string): ProviderCatalog {
  const unreadable = () => new ServerError({ class: "internal", message: `Received an unreadable ${harness} provider catalog` })
  if (!isRecord(body) || !Array.isArray(body.all) || !Array.isArray(body.connected) || !isRecord(body.default)) throw unreadable()
  const all = body.all.map(providerOf)
  if (all.some((provider) => !provider)) throw unreadable()
  const defaults: Record<string, string> = {}
  for (const [provider, model] of Object.entries(body.default)) {
    if (typeof model !== "string") throw unreadable()
    defaults[provider] = model
  }
  return {
    all: all.filter((provider): provider is CatalogProvider => !!provider),
    connected: body.connected.filter((id): id is string => typeof id === "string"),
    default: defaults,
  }
}
