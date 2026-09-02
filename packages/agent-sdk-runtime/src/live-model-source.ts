import { Log } from "./log"
import { SDK_MODEL_CATALOG, type NativeSdkHarnessId, type SdkModelEntry } from "./sdk-model-catalog"

const log = Log.create({ service: "live-model-source" })

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_SCOPE = ""

type CachedModels = {
  models: readonly SdkModelEntry[]
  fetchedAt: number
}

export type LiveModelSource = {
  /** Live model list; serves the cache while fresh, refetches when stale, and falls back to the last good list or the static catalog. */
  models(directory?: string): Promise<readonly SdkModelEntry[]>
  /** Cached list without triggering a fetch; the static catalog before the first successful fetch. */
  peek(directory?: string): readonly SdkModelEntry[]
  /** Drop every cached and in-flight list, for when auth or config changed underneath it. */
  invalidate(): void
}

/**
 * Every SDK harness can serve its model list live (Claude SDK `supportedModels`,
 * Codex app-server `model/list`, Cursor `Cursor.models.list`), but each needs a
 * running process or a network call to answer. This wraps a harness fetcher with
 * the shared policy: per-directory TTL cache, single-flight, and fallback to the
 * last good list — then the static catalog — so the picker endpoint never fails
 * or renders empty just because the harness is unreachable.
 */
export function createLiveModelSource(input: {
  harness: NativeSdkHarnessId
  fetchModels: (directory?: string) => Promise<SdkModelEntry[]>
  ttlMs?: number
  /** When false, a cold fetch failure propagates instead of serving the static catalog. */
  fallbackToCatalog?: boolean
}): LiveModelSource {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS
  const fallbackToCatalog = input.fallbackToCatalog ?? true
  const cache = new Map<string, CachedModels>()
  const inflight = new Map<string, Promise<SdkModelEntry[]>>()

  /** Last good list for this scope, then the static catalog. Never an empty live answer. */
  function fallback(scope: string): readonly SdkModelEntry[] {
    const cached = cache.get(scope)
    if (cached) return cached.models
    return fallbackToCatalog ? SDK_MODEL_CATALOG[input.harness] : []
  }

  async function models(directory?: string): Promise<readonly SdkModelEntry[]> {
    const scope = directory ?? DEFAULT_SCOPE
    const cached = cache.get(scope)
    if (cached && Date.now() - cached.fetchedAt < ttl) return cached.models
    let request = inflight.get(scope)
    if (!request) {
      request = input.fetchModels(directory).finally(() => inflight.delete(scope))
      inflight.set(scope, request)
    }
    try {
      const next = await request
      // An empty answer is indistinguishable from "the harness could not tell
      // us", so it neither replaces a good list nor becomes the cached one.
      if (next.length > 0) {
        cache.set(scope, { models: next, fetchedAt: Date.now() })
        return next
      }
      log.warn("live model list came back empty; serving fallback", { harness: input.harness, directory })
    } catch (err) {
      log.warn("live model list failed; serving fallback", { harness: input.harness, directory, err })
      // A list that already worked outranks a transient outage, so it is served
      // whatever the catalog policy. Only a cold failure with no catalog to fall
      // back on has nothing to offer, and there the cause beats an empty list.
      if (!cache.has(scope) && !fallbackToCatalog) throw err
    }
    // The failed/empty attempt leaves `fetchedAt` alone, so the next call
    // retries instead of waiting out a TTL it never earned.
    return fallback(scope)
  }

  function peek(directory?: string): readonly SdkModelEntry[] {
    return fallback(directory ?? DEFAULT_SCOPE)
  }

  function invalidate() {
    cache.clear()
    inflight.clear()
  }

  return { models, peek, invalidate }
}
