import { describe, expect, test } from "bun:test"
import { createRehydrator, type CacheStore } from "./rehydrator"

// The rehydrator is the generic cold→warm→live cache primitive under every
// durable projection: it exposes a warm snapshot from cache immediately, then
// lets live server state win and writes it back. These specs drive that
// three-phase machine directly instead of through a domain wrapper.

type StoredValue = { revision: number }

function fakeCache(initial: Record<string, unknown> = {}): CacheStore & {
  writes: Array<{ key: string; value: unknown }>
  deletes: string[]
} {
  const store = new Map<string, unknown>(Object.entries(initial))
  const writes: Array<{ key: string; value: unknown }> = []
  const deletes: string[] = []
  return {
    writes,
    deletes,
    async get<T>(key: string) {
      return store.get(key) as T | undefined
    },
    async set<T>(key: string, value: T) {
      store.set(key, value)
      writes.push({ key, value })
    },
    async delete(key: string) {
      store.delete(key)
      deletes.push(key)
    },
    async clear() {
      store.clear()
    },
  }
}

describe("createRehydrator", () => {
  test("starts cold before any phase runs", () => {
    const rehydrator = createRehydrator<StoredValue>({
      key: "projection:x",
      cache: fakeCache(),
      loadLive: async () => undefined,
    })

    expect(rehydrator.snapshot()).toEqual({ phase: "cold" })
  })

  test("warm surfaces a cached value without touching the live loader", async () => {
    let liveCalls = 0
    const rehydrator = createRehydrator<StoredValue>({
      key: "projection:x",
      cache: fakeCache({ "projection:x": { revision: 1 } }),
      loadLive: async () => {
        liveCalls += 1
        return { revision: 2 }
      },
    })

    expect(await rehydrator.warm()).toEqual({ phase: "warm", value: { revision: 1 } })
    expect(rehydrator.snapshot()).toEqual({ phase: "warm", value: { revision: 1 } })
    expect(liveCalls).toBe(0)
  })

  test("warm reports a value-less warm phase when the cache is empty", async () => {
    const rehydrator = createRehydrator<StoredValue>({
      key: "projection:x",
      cache: fakeCache(),
      loadLive: async () => undefined,
    })

    expect(await rehydrator.warm()).toEqual({ phase: "warm" })
  })

  test("live wins over warm and writes the live value back to cache", async () => {
    const cache = fakeCache({ "projection:x": { revision: 1 } })
    const rehydrator = createRehydrator<StoredValue>({
      key: "projection:x",
      cache,
      loadLive: async () => ({ revision: 9 }),
    })

    await rehydrator.warm()
    expect(await rehydrator.live()).toEqual({ phase: "live", value: { revision: 9 } })
    expect(cache.writes).toEqual([{ key: "projection:x", value: { revision: 9 } }])
  })

  test("live keeps the warm value (and writes nothing) when the loader returns undefined", async () => {
    const cache = fakeCache({ "projection:x": { revision: 4 } })
    const rehydrator = createRehydrator<StoredValue>({
      key: "projection:x",
      cache,
      loadLive: async () => undefined,
    })

    await rehydrator.warm()
    expect(await rehydrator.live()).toEqual({ phase: "live", value: { revision: 4 } })
    expect(cache.writes).toEqual([])
  })

  test("live with no warm value and an empty loader lands on a value-less live phase", async () => {
    const cache = fakeCache()
    const rehydrator = createRehydrator<StoredValue>({
      key: "projection:x",
      cache,
      loadLive: async () => undefined,
    })

    expect(await rehydrator.live()).toEqual({ phase: "live" })
    expect(cache.writes).toEqual([])
  })

  test("run walks warm then live, ending on the live snapshot", async () => {
    const cache = fakeCache({ "projection:x": { revision: 1 } })
    const phases: string[] = []
    const rehydrator = createRehydrator<StoredValue>({
      key: "projection:x",
      cache,
      loadLive: async () => {
        phases.push(rehydrator.snapshot().phase)
        return { revision: 7 }
      },
    })

    expect(await rehydrator.run()).toEqual({ phase: "live", value: { revision: 7 } })
    // The loader ran AFTER warm resolved, so it observed the warm phase.
    expect(phases).toEqual(["warm"])
    expect(cache.writes).toEqual([{ key: "projection:x", value: { revision: 7 } }])
  })
})
