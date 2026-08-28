import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"

import { Schema } from "effect"
import crypto from "crypto"
import fs from "fs/promises"
import path from "path"

/**
 * Memoized wire bodies for `GET /provider`.
 *
 * The full-list body is ~4.7 MB over the real models.dev catalogue; the
 * schema encode is ~48 ms and the stringify ~12 ms per request (measured on
 * the 183-provider / 6,280-model catalogue). Every input of that body is
 * identity-stable for exactly as long as the body cannot change, so the memo
 * key IS the input object identities — there is no enumerated invalidation
 * list to get wrong:
 *
 * - `connected` (`State.providers`) and `catalog` (`State.catalog`) come from
 *   Provider.Service's per-directory InstanceState. Both are only written
 *   inside the instance-state initializer; auth/config changes become visible
 *   through instance dispose/reload, which builds NEW records.
 * - `all` is the ModelsDev map behind `Effect.cachedInvalidateWithTTL`; a
 *   models.dev refresh invalidates that cache and produces a NEW map.
 * - `config` is `State.config` from Config.Service's per-directory
 *   InstanceState; config updates mark the instance for disposal, which
 *   builds a NEW object.
 *
 * A WeakMap chain over those identities therefore misses — fails closed — on
 * every path that could change the body, and dead entries become unreachable
 * together with the state they were derived from.
 *
 * TRADE, stated plainly: the route serves these cached bytes via `handleRaw`,
 * so the HttpApi framework no longer runs the success-schema encode per
 * response. The identical encode (`Schema.encodeUnknownSync(Provider.ListResult)`
 * then `JSON.stringify`, which is exactly what HttpApiBuilder's Json response
 * encoding does) runs here once per distinct input set; cache hits replay
 * those already-validated bytes without re-validating.
 *
 * Disk layer: the zero-`connected` full-list body is additionally persisted
 * under Global.Path.cache (beside the models.json cache it derives from) so a
 * fresh process skips the encode entirely. It fails closed:
 * - the key digests the exact catalog record and config object the body is
 *   derived from — NOT models.json: after a mid-process models.dev refresh
 *   the instance catalog is intentionally stale until reload, and keying on
 *   the newer models map would persist that stale body under a fresh key;
 * - the installation version is part of the key (encode/serialization code
 *   changes ship as new versions), and a `local` dev build never reads or
 *   writes the disk layer at all;
 * - any digest failure, key mismatch, or unreadable file re-derives;
 * - bodies with connected providers are NEVER persisted — connected provider
 *   Infos can carry `key` material, and this cache must not copy secrets out
 *   of auth.json. The zero-connected body is pure models.dev-derived data.
 * Plain node `fs` is used deliberately: this is a best-effort byte cache whose
 * failures must stay invisible to the route, not domain state that belongs in
 * FSUtil-managed effects.
 */

export interface ProviderListConfig {
  readonly disabled_providers?: readonly string[]
  readonly enabled_providers?: readonly string[]
}

export interface ProviderListInputs {
  readonly all: Record<string, ModelsDev.Provider>
  readonly catalog: Record<ProviderV2.ID, Provider.Info>
  readonly connected: Record<ProviderV2.ID, Provider.Info>
  readonly config: ProviderListConfig
}

export interface ProviderListQuery {
  readonly selectedProvider: string | null
  readonly indexOnly: boolean
}

export interface ProviderListBodyOptions {
  readonly cacheDir?: string
  readonly version?: string
}

/** Observable counters so tests count encodes and disk traffic instead of inferring from timing. */
export const ProviderListCacheInternals = {
  encodes: 0,
  diskHits: 0,
  diskWrites: 0,
  reset() {
    this.encodes = 0
    this.diskHits = 0
    this.diskWrites = 0
  },
}

/** Ported verbatim from the previous inline `ProviderHttpApi.list` handler branches. */
export function buildListResult(inputs: ProviderListInputs, query: ProviderListQuery): Provider.ListResult {
  const { all, catalog, connected, config } = inputs
  const disabled = new Set(config.disabled_providers ?? [])
  const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
  const allowed = (key: string) => (enabled ? enabled.has(key) : true) && !disabled.has(key)
  const activeConnected = Object.fromEntries(Object.entries(connected).filter(([key]) => allowed(key)))
  const connectedIDs = Object.keys(activeConnected)
  if (query.indexOnly) {
    const filtered = Object.fromEntries(Object.entries(all).filter(([key]) => allowed(key)))
    const defaults = Provider.defaultModelIDs(activeConnected)
    const providers = new Map(Object.entries(filtered).map(([id, item]) => [id, { id, name: item.name }] as const))
    Object.entries(activeConnected).forEach(([id, item]) => providers.set(id, { id, name: item.name }))
    return {
      all: [...providers.values()].map((item) => {
        const connectedProvider = activeConnected[ProviderV2.ID.make(item.id)]
        const defaultModel = defaults[item.id]
        return {
          id: ProviderV2.ID.make(item.id),
          name: item.name,
          source: connectedProvider?.source ?? ("custom" as const),
          env: [],
          options: {},
          models:
            connectedProvider && defaultModel && connectedProvider.models[defaultModel]
              ? { [defaultModel]: Provider.toPublicInfo(connectedProvider).models[defaultModel]! }
              : {},
        }
      }),
      default: defaults,
      connected: connectedIDs,
    }
  }
  if (query.selectedProvider) {
    const filtered = Object.fromEntries(Object.entries(all).filter(([key]) => allowed(key)))
    const id = ProviderV2.ID.make(query.selectedProvider)
    const selected =
      activeConnected[id] ??
      (filtered[query.selectedProvider] ? Provider.fromModelsDevProvider(filtered[query.selectedProvider]) : undefined)
    return {
      all: selected ? [Provider.toPublicInfo(selected)] : [],
      default: Provider.defaultModelIDs({ ...activeConnected, ...(selected ? { [id]: selected } : {}) }),
      connected: connectedIDs,
    }
  }
  // Serve the immutable per-instance catalog (Provider.State.catalog)
  // instead of re-deriving every provider from models.dev on each request.
  // Catalog entries are returned without cloning: the response encode
  // already produces a fresh tree. Connected entries keep the defensive
  // `toPublicInfo` clone because they hold live, mutable provider state.
  const providers: Record<string, Provider.Info> = Object.assign(
    Object.fromEntries(Object.entries(catalog).filter(([key]) => allowed(key))),
    activeConnected,
  )
  return {
    all: Object.entries(providers).map(([key, item]) => (key in activeConnected ? Provider.toPublicInfo(item) : item)),
    default: Provider.defaultModelIDs(providers),
    connected: connectedIDs,
  }
}

const encodeListResult = Schema.encodeUnknownSync(Provider.ListResult)

function encodeBody(payload: Provider.ListResult): string {
  ProviderListCacheInternals.encodes++
  return JSON.stringify(encodeListResult(payload))
}

type BodyCache = Map<string, string>

const memo = new WeakMap<object, WeakMap<object, WeakMap<object, WeakMap<object, BodyCache>>>>()

function bodyCacheFor(inputs: ProviderListInputs): BodyCache {
  let byCatalog = memo.get(inputs.connected)
  if (!byCatalog) memo.set(inputs.connected, (byCatalog = new WeakMap()))
  let byAll = byCatalog.get(inputs.catalog)
  if (!byAll) byCatalog.set(inputs.catalog, (byAll = new WeakMap()))
  let byConfig = byAll.get(inputs.all)
  if (!byConfig) byAll.set(inputs.all, (byConfig = new WeakMap()))
  let cache = byConfig.get(inputs.config)
  if (!cache) byConfig.set(inputs.config, (cache = new Map()))
  return cache
}

function queryKey(query: ProviderListQuery): string {
  return `${query.indexOnly ? "index" : "list"}|${query.selectedProvider ?? ""}`
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function digestOf(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? undefined : sha256(json)
  } catch {
    return undefined
  }
}

const catalogDigestMemo = new WeakMap<object, string | undefined>()

function catalogDigest(catalog: Record<ProviderV2.ID, Provider.Info>): string | undefined {
  if (catalogDigestMemo.has(catalog)) return catalogDigestMemo.get(catalog)
  const digest = digestOf(catalog)
  catalogDigestMemo.set(catalog, digest)
  return digest
}

function diskPaths(cacheDir: string) {
  return {
    entry: path.join(cacheDir, "provider-list.v1.json"),
  }
}

function diskKey(inputs: ProviderListInputs, version: string): string | undefined {
  const catalog = catalogDigest(inputs.catalog)
  if (!catalog) return undefined
  const config = digestOf(inputs.config)
  if (!config) return undefined
  return sha256(`provider-list.v1|${version}|catalog:${catalog}|config:${config}`)
}

async function readDiskBody(cacheDir: string, key: string): Promise<string | undefined> {
  try {
    const paths = diskPaths(cacheDir)
    const entry = JSON.parse(await fs.readFile(paths.entry, "utf8")) as { key?: unknown; body?: unknown }
    if (entry.key !== key || typeof entry.body !== "string") return undefined
    const body = entry.body
    if (!body.startsWith("{")) return undefined
    return body
  } catch {
    return undefined
  }
}

async function writeDiskBody(cacheDir: string, key: string, body: string): Promise<void> {
  const paths = diskPaths(cacheDir)
  const temporary = `${paths.entry}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    // Key and body are one atomic entry. Concurrent writers may replace one
    // another, but readers can never observe a key from one derivation paired
    // with the body from another.
    await fs.writeFile(temporary, JSON.stringify({ key, body }), "utf8")
    await fs.rename(temporary, paths.entry)
    ProviderListCacheInternals.diskWrites++
  } catch {
    // Best effort: a failed write only costs the next launch a re-derive.
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function providerListBody(
  inputs: ProviderListInputs,
  query: ProviderListQuery,
  options: ProviderListBodyOptions = {},
): Promise<string> {
  const cache = bodyCacheFor(inputs)
  const cacheKey = queryKey(query)
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit

  const version = options.version ?? InstallationVersion
  const cacheDir = options.cacheDir ?? Global.Path.cache
  const diskEligible =
    !query.indexOnly && !query.selectedProvider && Object.keys(inputs.connected).length === 0 && version !== "local"
  const key = diskEligible ? diskKey(inputs, version) : undefined

  if (key) {
    const fromDisk = await readDiskBody(cacheDir, key)
    if (fromDisk !== undefined) {
      ProviderListCacheInternals.diskHits++
      cache.set(cacheKey, fromDisk)
      return fromDisk
    }
  }

  const body = encodeBody(buildListResult(inputs, query))
  cache.set(cacheKey, body)
  if (key) await writeDiskBody(cacheDir, key, body)
  return body
}
