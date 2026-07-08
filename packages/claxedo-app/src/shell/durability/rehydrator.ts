export type CacheStore = {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

export type RehydratorPhase = "cold" | "warm" | "live"

export type RehydratorSnapshot<T> = {
  phase: RehydratorPhase
  value?: T
}

export function createRehydrator<T>(input: {
  key: string
  cache: CacheStore
  loadLive: () => Promise<T | undefined>
}) {
  let snapshot: RehydratorSnapshot<T> = { phase: "cold" }

  return {
    snapshot: () => snapshot,
    async warm() {
      const value = await input.cache.get<T>(input.key)
      snapshot = value === undefined ? { phase: "warm" } : { phase: "warm", value }
      return snapshot
    },
    async live() {
      const value = await input.loadLive()
      if (value !== undefined) {
        await input.cache.set(input.key, value)
        snapshot = { phase: "live", value }
        return snapshot
      }
      snapshot = snapshot.value === undefined ? { phase: "live" } : { phase: "live", value: snapshot.value }
      return snapshot
    },
    async run() {
      await this.warm()
      return await this.live()
    },
  }
}
