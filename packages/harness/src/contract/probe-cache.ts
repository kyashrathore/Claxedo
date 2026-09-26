import type { Clock } from "./services"
import type { DraftLaunch } from "./transport"

export function draftProbeKey(draft: DraftLaunch, ...extra: unknown[]): string {
  return JSON.stringify([draft.workspaceId, draft.directory, draft.locality, draft.owner, draft.config.harness, draft.model,
    draft.projection.generation, draft.credentials.leaseGeneration, ...extra])
}

type ProbeEntry<T> = { result: Promise<T>; expiresAt: number; value?: { settled: T } }

export class DraftProbeCache<T> {
  private readonly entries = new Map<string, ProbeEntry<T>>()

  constructor(private readonly clock: Clock, private readonly ttlMs = 30_000, private readonly maxEntries = 64) {}

  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): Promise<T> | undefined {
    return this.live(key)?.result
  }

  peek(key: string): T | undefined {
    return this.live(key)?.value?.settled
  }

  set(key: string, result: Promise<T>): Promise<T> {
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
    const entry: ProbeEntry<T> = { result, expiresAt: this.clock.now() + this.ttlMs }
    this.entries.set(key, entry)
    void result.then((settled) => { entry.value = { settled } }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return result
  }

  private live(key: string): ProbeEntry<T> | undefined {
    const now = this.clock.now()
    for (const [cachedKey, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(cachedKey)
    return this.entries.get(key)
  }
}
