import type { SdkModelEntry } from "./sdk-model-catalog"

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_SCOPE = ""

type CachedModels = {
  models: readonly SdkModelEntry[]
  fetchedAt: number
}

export type LiveModelSource = {
  models(directory?: string): Promise<readonly SdkModelEntry[]>
  peek(directory?: string): readonly SdkModelEntry[]
  invalidate(): void
}

export function createLiveModelSource(input: {
  fetchModels: (directory?: string) => Promise<SdkModelEntry[]>
  ttlMs?: number
}): LiveModelSource {
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, CachedModels>()
  const inflight = new Map<string, Promise<SdkModelEntry[]>>()

  async function models(directory?: string): Promise<readonly SdkModelEntry[]> {
    const scope = directory ?? DEFAULT_SCOPE
    const cached = cache.get(scope)
    if (cached && Date.now() - cached.fetchedAt < ttl) return cached.models
    let request = inflight.get(scope)
    if (!request) {
      request = input.fetchModels(directory).finally(() => inflight.delete(scope))
      inflight.set(scope, request)
    }
    const next = await request
    cache.set(scope, { models: next, fetchedAt: Date.now() })
    return next
  }

  function peek(directory?: string): readonly SdkModelEntry[] {
    return cache.get(directory ?? DEFAULT_SCOPE)?.models ?? []
  }

  function invalidate() {
    cache.clear()
    inflight.clear()
  }

  return { models, peek, invalidate }
}
