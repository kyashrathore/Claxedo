import { Log } from "./log"
import type { NativeSdkHarnessId } from "@claxedo/agent-runtime-contract"
import type { SdkModelEntry } from "./sdk-model-options"

const log = Log.create({ service: "live-model-source" })

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_SCOPE = ""

type CachedModels = {
  models: readonly SdkModelEntry[]
  fetchedAt: number
}

export type LiveModelSource = {
  /** Live model list; serves the cache while fresh, refetches when stale, and serves the last good list when a refetch fails. */
  models(directory?: string): Promise<readonly SdkModelEntry[]>
  /** Cached list without triggering a fetch; empty until a fetch has answered. */
  peek(directory?: string): readonly SdkModelEntry[]
  /** Drop every cached and in-flight list, for when auth or config changed underneath it. */
  invalidate(): void
}

/**
 * Every SDK harness can serve its model list live (Claude SDK `supportedModels`,
 * Codex app-server `model/list`, Cursor `Cursor.models.list`), but each needs a
 * running process or a network call to answer. This wraps a harness fetcher with
 * the shared policy: per-directory TTL cache, single-flight, and the last good
 * list when a refetch fails. Nothing is synthesized — a harness that has never
 * answered has no model list, and saying so beats naming models it may not serve.
 */
export function createLiveModelSource(input: {
  harness: NativeSdkHarnessId
  fetchModels: (directory?: string) => Promise<SdkModelEntry[]>
  ttlMs?: number
}): LiveModelSource {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, CachedModels>()
  const inflight = new Map<string, Promise<SdkModelEntry[]>>()

  function lastGood(scope: string): readonly SdkModelEntry[] {
    return cache.get(scope)?.models ?? []
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
      log.warn("live model list came back empty; serving the last good list", { harness: input.harness, directory })
    } catch (err) {
      log.warn("live model list failed; serving the last good list", { harness: input.harness, directory, err })
      // A list that already worked outranks a transient outage. A cold failure
      // has nothing to offer, and there the cause beats an empty list.
      if (!cache.has(scope)) throw err
    }
    // The failed/empty attempt leaves `fetchedAt` alone, so the next call
    // retries instead of waiting out a TTL it never earned.
    return lastGood(scope)
  }

  function peek(directory?: string): readonly SdkModelEntry[] {
    return lastGood(directory ?? DEFAULT_SCOPE)
  }

  function invalidate() {
    cache.clear()
    inflight.clear()
  }

  return { models, peek, invalidate }
}
