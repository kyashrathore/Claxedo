/**
 * The OpenCode provider/model catalog, owned by Claxedo.
 *
 * R7 requires the provider/model catalog to keep working "without raw engine
 * control routes". Until now OpenCode was the one harness whose catalog came
 * from the engine, which meant a missing engine artifact emptied the model
 * picker — and after the SDK cutover it would fail outright, because
 * `provider.list` returns 500 on an embedded host (the default workspace
 * driver is `registryNode({})`, an empty provider registry; see
 * `docs/architecture/opencode-embedded-sdk-contract.md` §2.2).
 *
 * Source choice, deliberately: models.dev, the same catalog the engine reads.
 * Claxedo already ships an offline registry (`piModelCatalog`), and reusing it
 * would be cheaper — but it carries 31 providers against models.dev's 203, so
 * switching would silently delete 177 providers from the model picker. Matching
 * what users see today is worth owning a small cache.
 *
 * Failure stays explicit. With neither a live fetch nor a cached copy this
 * THROWS rather than returning an empty catalog: an unavailable catalog is not
 * the same fact as "there are no providers", and `providerBody` and its
 * contract tests depend on that distinction.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { dataDir } from "../platform/runtime/lib/paths"
import { requireCredentialRegistryLookup } from "./registry"

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

export type OpenCodeCatalog = {
  all: Array<{ id: string; name: string; env: string[]; source: string; models: Record<string, OpenCodeCatalogModel> }>
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

function readCache(env: NodeJS.ProcessEnv): { at: number; body: Record<string, ModelsDevProvider> } | undefined {
  const file = cachePath(env)
  if (!fs.existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { at?: number; body?: unknown }
    if (typeof parsed.at !== "number" || !parsed.body || typeof parsed.body !== "object") return undefined
    return { at: parsed.at, body: parsed.body as Record<string, ModelsDevProvider> }
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
  const body = await response.json() as unknown
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OpenCodeCatalogUnavailableError("models.dev returned a non-object catalog")
  }
  return body as Record<string, ModelsDevProvider>
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

function providerConnected(provider: ModelsDevProvider, id: string, env: NodeJS.ProcessEnv): boolean {
  if (requireCredentialRegistryLookup(id)?.status === "available") return true
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
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: CatalogFetch; now?: number } = {},
): Promise<OpenCodeCatalog> {
  const env = options.env ?? process.env
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
    if (providerConnected(provider, id, env)) connected.push(id)
  }

  if (all.length === 0) {
    throw new OpenCodeCatalogUnavailableError("the OpenCode model catalog contained no providers")
  }

  return { all, connected, default: defaults }
}
