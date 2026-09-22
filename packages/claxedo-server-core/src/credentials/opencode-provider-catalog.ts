/**
 * The OpenCode provider/model catalog, owned by Claxedo rather than read from
 * the engine: `provider.list` returns 500 on an embedded host, whose default
 * workspace driver is `registryNode({})`, an empty provider registry
 * (`docs/architecture/opencode-embedded-sdk-contract.md`).
 *
 * Source: models.dev, the same catalog the engine reads, overlaid with the
 * caller's org-scoped custom providers. The offline `piModelCatalog` would be
 * cheaper but carries 31 providers against models.dev's 203, so it would
 * silently shrink the model picker.
 *
 * With neither a live fetch nor a cached copy this throws rather than returning
 * an empty catalog: an unavailable catalog is not "there are no providers", and
 * `providerBody` and its contract tests depend on the distinction.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { isJsonRecord, jsonRecord, parseJsonRecord } from "../platform/runtime/lib/json"
import { dataDir } from "../platform/runtime/lib/paths"
import { listCustomProviders } from "./custom-provider"
import { vendorCredentialProviderIds } from "@claxedo/agent-runtime-contract"
import { credentialByProvider, credentialOrg, PROVIDER_AUTH_KINDS, type CredentialOrgScope } from "./registry"

const MODELS_DEV_URL = "https://models.dev/api.json"

/**
 * Only the call signature is used, so do not demand the whole `fetch`
 * interface — requiring `preconnect` and friends would force every caller and
 * test to fabricate them for no benefit.
 */
export type CatalogFetch = (url: string) => Promise<Response>

/** How long a cached catalog is served without revalidating. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type OpenCodeCatalogModel = {
  id: string
  name: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  limit?: unknown
  cost?: unknown
}

export type OpenCodeCatalogProvider = {
  id: string
  name: string
  env: string[]
  source: string
  models: Record<string, OpenCodeCatalogModel>
  /** Present on operator-declared providers: `baseURL` and non-secret headers. */
  options?: Record<string, unknown>
}

export type OpenCodeCatalog = {
  all: OpenCodeCatalogProvider[]
  connected: string[]
  default: Record<string, string>
}

type ModelsDevProvider = {
  id?: string
  name?: string
  env?: string[]
  models?: Record<string, Record<string, unknown>>
}

export class OpenCodeCatalogUnavailableError extends Error {
  readonly code = "opencode_catalog_unavailable"
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "OpenCodeCatalogUnavailableError"
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/**
 * Where the catalog snapshot lives.
 *
 * Overridable so an operator can place it on durable storage (a sandbox's
 * mounted volume rather than an ephemeral image layer), and so tests can
 * isolate it instead of inheriting a developer's real cache.
 */
function cachePath(env: NodeJS.ProcessEnv = process.env) {
  const override = env.CLAXEDO_OPENCODE_CATALOG_CACHE?.trim()
  return override || path.join(dataDir(), "opencode-model-catalog.json")
}

/**
 * The models.dev catalog, read once at its boundary.
 *
 * Every field of a provider entry is optional because the upstream document is
 * not ours: this narrows the envelope (an object of provider entries) and lets
 * each entry's fields be read as they are, rather than asserting a shape the
 * document never promised.
 */
function readCatalog(value: unknown): Record<string, ModelsDevProvider> | undefined {
  if (!isJsonRecord(value)) return undefined
  const catalog: Record<string, ModelsDevProvider> = {}
  for (const [id, entry] of Object.entries(value)) {
    const provider = jsonRecord(entry)
    if (!provider) continue
    catalog[id] = {
      ...(typeof provider.id === "string" ? { id: provider.id } : {}),
      ...(typeof provider.name === "string" ? { name: provider.name } : {}),
      ...(Array.isArray(provider.env) ? { env: provider.env.filter((item) => typeof item === "string") } : {}),
      ...(isJsonRecord(provider.models) ? { models: readModels(provider.models) } : {}),
    }
  }
  return catalog
}

function readModels(models: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, model] of Object.entries(models)) {
    const record = jsonRecord(model)
    if (record) out[id] = record
  }
  return out
}

function readCache(env: NodeJS.ProcessEnv): { at: number; body: Record<string, ModelsDevProvider> } | undefined {
  const file = cachePath(env)
  if (!fs.existsSync(file)) return undefined
  try {
    const parsed = parseJsonRecord(fs.readFileSync(file, "utf8"))
    const body = readCatalog(parsed?.body)
    if (typeof parsed?.at !== "number" || !body) return undefined
    return { at: parsed.at, body }
  } catch {
    // A corrupt cache is not a reason to fail; it is a reason to refetch.
    return undefined
  }
}

function writeCache(body: Record<string, ModelsDevProvider>, env: NodeJS.ProcessEnv) {
  const file = cachePath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write-then-rename so a crash cannot leave a half-written cache that the
  // next boot would parse as corrupt and discard.
  const pending = `${file}.pending`
  fs.writeFileSync(pending, JSON.stringify({ at: Date.now(), body }))
  fs.renameSync(pending, file)
}

async function fetchCatalog(fetchImpl: CatalogFetch): Promise<Record<string, ModelsDevProvider>> {
  const response = await fetchImpl(MODELS_DEV_URL)
  if (!response.ok) throw new OpenCodeCatalogUnavailableError(`models.dev responded ${response.status}`)
  const body = readCatalog(await response.json())
  if (!body) throw new OpenCodeCatalogUnavailableError("models.dev returned a non-object catalog")
  return body
}

/**
 * Resolve the raw catalog: fresh cache, else network, else stale cache.
 *
 * A stale cache beats a hard failure — a day-old model list is still a usable
 * picker, whereas an empty one is indistinguishable from "you have no
 * providers".
 */
export async function resolveModelsDevCatalog(
  options: { fetchImpl?: CatalogFetch; now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, ModelsDevProvider>> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const cached = readCache(env)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.body

  try {
    const body = await fetchCatalog(options.fetchImpl ?? ((url: string) => globalThis.fetch(url)))
    writeCache(body, env)
    return body
  } catch (cause) {
    if (cached) return cached.body
    throw new OpenCodeCatalogUnavailableError(
      "the OpenCode model catalog is unavailable and nothing is cached",
      { cause },
    )
  }
}

function providerConnected(
  provider: Pick<ModelsDevProvider, "env">,
  id: string,
  env: NodeJS.ProcessEnv,
  org: string,
): boolean {
  // OpenCode Zen is the house catalog: its models must be pickable without a
  // stored key. A provider that declares no env vars has the same bar.
  if (id === "opencode" || !(provider.env ?? []).length) return true
  // Every row the engine would bind for this provider, not only the one stored
  // under its own name: `reconcileCredentialsIntoSdk` binds a Claude Code
  // login to the engine's Anthropic provider, and a catalog that asked only
  // for `anthropic` called that provider unconnected while turns ran on it.
  const candidates = vendorCredentialProviderIds(id)
  if (candidates.some((candidate) =>
    credentialByProvider(candidate, { onOutage: "throw", kind: PROVIDER_AUTH_KINDS }, org)?.status === "available")) {
    return true
  }
  // models.dev names the environment variables a provider authenticates with;
  // an operator-supplied key counts as connected exactly as it does for the
  // harness-binding catalog.
  return (provider.env ?? []).some((key) => !!env[key]?.trim())
}

function toModel(raw: Record<string, unknown>, id: string): OpenCodeCatalogModel {
  return {
    id: typeof raw.id === "string" ? raw.id : id,
    name: typeof raw.name === "string" ? raw.name : id,
    attachment: raw.attachment === true,
    reasoning: raw.reasoning === true,
    tool_call: raw.tool_call !== false,
    temperature: raw.temperature === true,
    limit: raw.limit,
    cost: raw.cost,
  }
}

/** Build the catalog `providerBody` serves for the OpenCode harness. */
export async function opencodeProviderCatalog(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: CatalogFetch; now?: number; org?: CredentialOrgScope } = {},
): Promise<OpenCodeCatalog> {
  const env = options.env ?? process.env
  const org = credentialOrg(options.org)
  const raw = await resolveModelsDevCatalog({ ...options, env })

  const all: OpenCodeCatalog["all"] = []
  const connected: string[] = []
  const defaults: Record<string, string> = {}

  for (const [id, provider] of Object.entries(raw)) {
    if (!provider || typeof provider !== "object") continue
    const models = provider.models ?? {}
    const entries = Object.entries(models).filter(
      (entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object",
    )
    if (entries.length === 0) continue

    all.push({
      id,
      name: typeof provider.name === "string" ? provider.name : id,
      env: provider.env ?? [],
      source: "config",
      models: Object.fromEntries(entries.map(([modelId, model]) => [modelId, toModel(model, modelId)])),
    })

    // Stable default: models.dev key order is not guaranteed, so sort rather
    // than trusting whichever key happened to come first.
    const first = entries.map(([modelId]) => modelId).sort()[0]
    if (first) defaults[id] = first
    if (providerConnected(provider, id, env, org)) connected.push(id)
  }

  if (all.length === 0) {
    throw new OpenCodeCatalogUnavailableError("the OpenCode model catalog contained no providers")
  }

  return mergeCustomProviders({ all, connected, default: defaults }, env, org)
}

/**
 * Overlay the org's operator-declared providers.
 *
 * A custom provider REPLACES a models.dev row of the same id: the operator
 * pointed that id at their own base URL, and serving both would leave the
 * picker showing one name for two different endpoints.
 */
function mergeCustomProviders(catalog: OpenCodeCatalog, env: NodeJS.ProcessEnv, org: string): OpenCodeCatalog {
  const custom = listCustomProviders(org)
  if (custom.length === 0) return catalog

  const byId = new Map(catalog.all.map((provider) => [provider.id, provider]))
  const connected = new Set(catalog.connected)
  const defaults = { ...catalog.default }

  for (const provider of custom) {
    byId.set(provider.providerID, {
      id: provider.providerID,
      name: provider.name,
      env: provider.env,
      source: "custom",
      models: Object.fromEntries(
        Object.entries(provider.models).map(([id, model]) => [id, { id, name: model.name, tool_call: true }]),
      ),
      options: { baseURL: provider.baseURL, ...(Object.keys(provider.headers).length ? { headers: provider.headers } : {}) },
    })
    const first = Object.keys(provider.models).sort()[0]
    if (first) defaults[provider.providerID] = first
    if (providerConnected(provider, provider.providerID, env, org)) connected.add(provider.providerID)
    else connected.delete(provider.providerID)
  }

  return { all: [...byId.values()], connected: [...connected], default: defaults }
}
