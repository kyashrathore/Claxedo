import { describe, expect, test } from "bun:test"
import {
  createLruResourceCache,
  createRefCountedLruResourceCache,
  createRefCountedResourceCache,
} from "./live-resource-cache"

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

describe("createRefCountedLruResourceCache", () => {
  // The two properties that make this factory necessary, one per sibling:
  //   1. it RETAINS on release   — `createRefCountedResourceCache` disposes there
  //   2. it PINS the referenced  — `createLruResourceCache` has no idea who reads
  test("release retains the entry instead of disposing it, so a re-acquire is the same value", () => {
    const log: string[] = []
    const cache = createRefCountedLruResourceCache<{ id: string }>(10)

    const first = cache.acquire("k", () => fakeResource(log, "k"))
    first.release()

    expect(log).toEqual([]) // NOT disposed: unreferenced is not the same as dead
    expect(cache.has("k")).toBe(true)

    const again = cache.acquire("k", () => fakeResource(log, "k-recreated"))
    expect(again.value).toBe(first.value)
  })

  test("never evicts a referenced entry, even when much older than the pressure", () => {
    const log: string[] = []
    const cache = createRefCountedLruResourceCache<{ id: string }>(2)

    const pinned = cache.acquire("pinned", () => fakeResource(log, "pinned"))
    for (let index = 0; index < 6; index++) {
      cache.acquire(`churn-${index}`, () => fakeResource(log, `churn-${index}`)).release()
    }

    expect(log).not.toContain("dispose:pinned")
    expect(cache.has("pinned")).toBe(true)
    expect(pinned.value).toBe(cache.acquire("pinned", () => fakeResource(log, "nope")).value)
  })

  test("skips a pinned entry under pressure, then evicts it oldest-first once unpinned", () => {
    const log: string[] = []
    const cache = createRefCountedLruResourceCache<{ id: string }>(2)

    const a = cache.acquire("a", () => fakeResource(log, "a"))
    cache.acquire("b", () => fakeResource(log, "b")).release()
    cache.acquire("c", () => fakeResource(log, "c")).release()

    // "a" is the oldest but pinned, so the pressure fell on "b" instead.
    expect(log).toEqual(["dispose:b"])
    expect(cache.has("a")).toBe(true)

    // Releasing the last pin RETAINS — dropping to zero refs is not a teardown
    // signal here, it only makes the entry a candidate.
    a.release()
    expect(log).toEqual(["dispose:b"])
    expect(cache.has("a")).toBe(true)

    // ...and the next slot needed takes it, as the oldest unpinned entry.
    cache.acquire("d", () => fakeResource(log, "d")).release()
    expect(log).toEqual(["dispose:b", "dispose:a"])
    expect(cache.size()).toBe(2)
  })

  test("a second acquire re-pins a retained entry so pressure cannot take it", () => {
    const log: string[] = []
    const cache = createRefCountedLruResourceCache<{ id: string }>(1)

    cache.acquire("k", () => fakeResource(log, "k")).release() // retained, unpinned
    const repinned = cache.acquire("k", () => fakeResource(log, "k-recreated"))
    cache.acquire("other", () => fakeResource(log, "other")).release()

    expect(log).toEqual(["dispose:other"])
    expect(cache.has("k")).toBe(true)
    repinned.release()
  })

  test("two consumers share one value and it survives until the last releases", () => {
    const created: string[] = []
    const log: string[] = []
    const cache = createRefCountedLruResourceCache<{ id: string }>(1)

    const a = cache.acquire("k", () => {
      created.push("k")
      return fakeResource(log, "k")
    })
    const b = cache.acquire("k", () => {
      created.push("k-again")
      return fakeResource(log, "k")
    })

    expect(created).toEqual(["k"])
    expect(a.value).toBe(b.value)

    a.release()
    cache.acquire("pressure", () => fakeResource(log, "pressure")) // over max
    expect(log).toEqual([]) // b still pins "k"; "pressure" is pinned too

    b.release()
    expect(log).toEqual(["dispose:k"])
  })

  test("a stale double-release cannot go negative or un-pin someone else's ref", () => {
    const log: string[] = []
    const cache = createRefCountedLruResourceCache<{ id: string }>(1)

    const a = cache.acquire("k", () => fakeResource(log, "k"))
    const b = cache.acquire("k", () => fakeResource(log, "k"))

    a.release()
    a.release() // stale repeat: must not release b's ref
    cache.acquire("pressure", () => fakeResource(log, "pressure")).release()

    // "k" is still pinned by b, so the only evictable entry was "pressure"
    // itself. Had the stale release decremented b's ref, "k" would have gone.
    expect(log).toEqual(["dispose:pressure"])
    expect(cache.has("k")).toBe(true)

    // b holds the only surviving ref, so this is the release that unpins "k" —
    // proof the stale double-release above consumed a's ref and nothing more.
    b.release()
    expect(log).toEqual(["dispose:pressure"])
    cache.acquire("next", () => fakeResource(log, "next")).release()
    expect(log).toEqual(["dispose:pressure", "dispose:k"])
  })

  test("a brand-new entry is never the one evicted to make room for itself", () => {
    const log: string[] = []
    const cache = createRefCountedLruResourceCache<{ id: string }>(1)

    cache.acquire("old", () => fakeResource(log, "old")).release()
    const fresh = cache.acquire("fresh", () => fakeResource(log, "fresh"))

    expect(log).toEqual(["dispose:old"])
    expect(fresh.value).toEqual({ id: "fresh" })
    expect(cache.has("fresh")).toBe(true)
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
