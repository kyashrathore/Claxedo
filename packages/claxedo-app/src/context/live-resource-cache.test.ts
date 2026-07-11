import { describe, expect, test } from "bun:test"
import { createLruResourceCache, createRefCountedResourceCache } from "./live-resource-cache"

// These caches back the shared terminal/prompt sessions in terminal.tsx and
// prompt.tsx. The contract that actually matters — dispose-once ref-counting
// and bounded eviction — is exercised here against fake create/dispose spies,
// no Solid mount required.

function fakeResource(log: string[], id: string) {
  return {
    value: { id },
    dispose: () => log.push(`dispose:${id}`),
  }
}

describe("createRefCountedResourceCache", () => {
  test("two acquires of the same key share one value and only create it once", () => {
    const created: string[] = []
    const cache = createRefCountedResourceCache<{ id: string }>(10)

    const a = cache.acquire("k", () => {
      created.push("k")
      return fakeResource([], "k")
    })
    const b = cache.acquire("k", () => {
      created.push("k-again")
      return fakeResource([], "k")
    })

    expect(created).toEqual(["k"])
    expect(a.value).toBe(b.value)
    expect(cache.size()).toBe(1)
  })

  test("resource is disposed exactly once, only after the last consumer releases", () => {
    const log: string[] = []
    const cache = createRefCountedResourceCache<{ id: string }>(10)

    const a = cache.acquire("k", () => fakeResource(log, "k"))
    const b = cache.acquire("k", () => fakeResource(log, "k"))

    a.release()
    expect(log).toEqual([]) // b still holds a ref
    expect(cache.has("k")).toBe(true)

    b.release()
    expect(log).toEqual(["dispose:k"])
    expect(cache.has("k")).toBe(false)
  })

  test("releasing more times than acquired disposes once and is then a no-op", () => {
    const log: string[] = []
    const cache = createRefCountedResourceCache<{ id: string }>(10)

    const a = cache.acquire("k", () => fakeResource(log, "k"))
    a.release()
    a.release() // stale double-release must not double-dispose or throw

    expect(log).toEqual(["dispose:k"])
  })

  test("prune evicts and disposes unreferenced entries oldest-first when over max", () => {
    const log: string[] = []
    const cache = createRefCountedResourceCache<{ id: string }>(2)

    const a = cache.acquire("a", () => fakeResource(log, "a"))
    a.release() // a is now unreferenced
    cache.acquire("b", () => fakeResource(log, "b")) // held
    cache.acquire("c", () => fakeResource(log, "c")) // held → size 3 > max, prune

    expect(log).toEqual(["dispose:a"])
    expect(cache.has("a")).toBe(false)
    expect(cache.has("b")).toBe(true)
    expect(cache.has("c")).toBe(true)
  })

  test("prune never evicts a still-referenced entry even when over max", () => {
    const log: string[] = []
    const cache = createRefCountedResourceCache<{ id: string }>(1)

    cache.acquire("a", () => fakeResource(log, "a")) // held, refs=1
    cache.acquire("b", () => fakeResource(log, "b")) // held, refs=1, over max

    expect(log).toEqual([]) // both referenced → nothing disposed
    expect(cache.size()).toBe(2)
  })
})

describe("createLruResourceCache", () => {
  test("load returns a cached value on hit without re-creating", () => {
    const created: string[] = []
    const cache = createLruResourceCache<{ id: string }>(10)

    const first = cache.load("k", () => {
      created.push("k")
      return fakeResource([], "k")
    })
    const second = cache.load("k", () => {
      created.push("k-again")
      return fakeResource([], "k")
    })

    expect(created).toEqual(["k"])
    expect(first).toBe(second)
  })

  test("evicts and disposes the least-recently-used entry when over max", () => {
    const log: string[] = []
    const cache = createLruResourceCache<{ id: string }>(2)

    cache.load("a", () => fakeResource(log, "a"))
    cache.load("b", () => fakeResource(log, "b"))
    cache.load("c", () => fakeResource(log, "c")) // size 3 > max → evict oldest "a"

    expect(log).toEqual(["dispose:a"])
    expect(cache.has("a")).toBe(false)
    expect(cache.has("b")).toBe(true)
    expect(cache.has("c")).toBe(true)
  })

  test("a hit refreshes recency so the touched key survives the next eviction", () => {
    const log: string[] = []
    const cache = createLruResourceCache<{ id: string }>(2)

    cache.load("a", () => fakeResource(log, "a"))
    cache.load("b", () => fakeResource(log, "b"))
    cache.load("a", () => fakeResource(log, "a")) // touch a → b is now oldest
    cache.load("c", () => fakeResource(log, "c")) // evict oldest "b"

    expect(log).toEqual(["dispose:b"])
    expect(cache.has("a")).toBe(true)
    expect(cache.has("b")).toBe(false)
    expect(cache.has("c")).toBe(true)
  })
})
