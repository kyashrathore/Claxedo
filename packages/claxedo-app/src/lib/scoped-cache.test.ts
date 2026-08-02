import { describe, expect, test } from "bun:test"
import { createScopedCache } from "./scoped-cache"

describe("createScopedCache", () => {
  test("creates a value once per key and returns the cached instance on subsequent gets", () => {
    let created = 0
    const cache = createScopedCache((key) => {
      created++
      return `value:${key}`
    })
    expect(cache.get("a")).toBe("value:a")
    expect(cache.get("a")).toBe("value:a")
    expect(created).toBe(1)
    cache.get("b")
    expect(created).toBe(2)
  })

  test("peek returns undefined for a missing key without creating it", () => {
    let created = 0
    const cache = createScopedCache(() => (created++, {}))
    expect(cache.peek("a")).toBeUndefined()
    expect(created).toBe(0)
  })

  test("evicts the least-recently-used entry past maxEntries and disposes it", () => {
    const disposed: string[] = []
    const cache = createScopedCache((key) => key, { maxEntries: 2, dispose: (_v, key) => disposed.push(key) })
    cache.get("a")
    cache.get("b")
    cache.get("a") // touch a so b is now the LRU
    cache.get("c") // pushes size to 3 -> evict LRU (b)
    expect(disposed).toEqual(["b"])
    expect(cache.peek("a")).toBe("a")
    expect(cache.peek("c")).toBe("c")
  })

  test("recreates a value after its ttl elapses", () => {
    let clock = 0
    let created = 0
    const cache = createScopedCache((key) => `${key}:${created++}`, { ttlMs: 100, now: () => clock })
    expect(cache.get("a")).toBe("a:0")
    clock = 50
    expect(cache.get("a")).toBe("a:0") // still fresh
    clock = 200
    expect(cache.get("a")).toBe("a:1") // expired -> recreated
  })

  test("delete removes, returns, and disposes the entry", () => {
    const disposed: string[] = []
    const cache = createScopedCache((key) => key, { dispose: (v) => disposed.push(v) })
    cache.get("a")
    expect(cache.delete("a")).toBe("a")
    expect(disposed).toEqual(["a"])
    expect(cache.peek("a")).toBeUndefined()
  })

  test("clear disposes every entry", () => {
    const disposed: string[] = []
    const cache = createScopedCache((key) => key, { dispose: (v) => disposed.push(v) })
    cache.get("a")
    cache.get("b")
    cache.clear()
    expect(disposed.sort()).toEqual(["a", "b"])
    expect(cache.peek("a")).toBeUndefined()
  })
})
