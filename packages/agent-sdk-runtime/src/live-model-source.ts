import { Log } from "./log"
import { SDK_MODEL_CATALOG, type NativeSdkHarnessId, type SdkModelEntry } from "./sdk-model-catalog"

const log = Log.create({ service: "live-model-source" })

const DEFAULT_TTL_MS = 10 * 60_000

export type LiveModelSource = {
  /** Live model list; serves the cache while fresh, refetches when stale, and falls back to the last good list or the static catalog. */
  models(directory?: string): Promise<readonly SdkModelEntry[]>
  /** Cached list without triggering a fetch; static catalog before the first successful fetch. */
  peek(): readonly SdkModelEntry[]
}

/**
 * Every SDK harness can serve its model list live (Claude SDK `supportedModels`,
 * Codex app-server `model/list`, Cursor `Cursor.models.list`), but each needs a
 * running process or a network call to answer. This wraps a harness fetcher with
 * the shared policy: TTL cache, single-flight, and fallback to the last good
 * list — then the static catalog — so the picker endpoint never fails just
 * because the harness is unreachable.
 */
export function createLiveModelSource(input: {
  harness: NativeSdkHarnessId
  fetchModels: (directory?: string) => Promise<SdkModelEntry[]>
  ttlMs?: number
  /** When false, fetch failures propagate instead of serving the static catalog. */
  fallbackToCatalog?: boolean
}): LiveModelSource {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS
  const fallbackToCatalog = input.fallbackToCatalog ?? true
  let cached: readonly SdkModelEntry[] | null = null
  let fetchedAt = 0
  let inflight: Promise<SdkModelEntry[]> | null = null

  async function models(directory?: string): Promise<readonly SdkModelEntry[]> {
    if (cached && Date.now() - fetchedAt < ttl) return cached
    inflight ??= input.fetchModels(directory).finally(() => {
      inflight = null
    })
    try {
      const list = await inflight
      if (list.length > 0) {
        cached = list
        fetchedAt = Date.now()
        return cached
      }
      log.warn("live model list came back empty; serving fallback", { harness: input.harness })
    } catch (err) {
      log.warn("live model list failed; serving fallback", { harness: input.harness, err })
      if (!fallbackToCatalog) throw err
    }
    if (!fallbackToCatalog) return cached ?? []
    return cached ?? SDK_MODEL_CATALOG[input.harness]
  }

  function peek(): readonly SdkModelEntry[] {
    if (!fallbackToCatalog && !cached) return []
    return cached ?? (fallbackToCatalog ? SDK_MODEL_CATALOG[input.harness] : [])
  }

  return { models, peek }
}
