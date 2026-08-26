import { describe, expect, test } from "bun:test"
import { MAX_OPEN_SURFACES, selectEvictableSurfaces } from "./surface-budget"

const ids = (count: number, prefix = "c") => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`)

// Fixtures derive from the configured cap so these tests pin the LRU and
// exemption SEMANTICS, not the tuned ceiling value: two surfaces past the cap,
// with names computed from the cap.
const cap = MAX_OPEN_SURFACES
const over = cap + 2
const id = (index: number) => `c${index}`

describe("state/surface-budget", () => {
  test("evicts nothing while at or under budget", () => {
    const contentIds = ids(cap)
    expect(selectEvictableSurfaces({ contentIds, contentRecency: contentIds })).toEqual([])
  })

  test("evicts the least-recently-used surfaces past the cap", () => {
    // Recency is MRU-first, so c1 is the newest and the last id the oldest.
    const contentIds = ids(over)
    expect(selectEvictableSurfaces({ contentIds, contentRecency: contentIds })).toEqual([id(cap + 1), id(cap + 2)])
  })

  test("recency order wins over contentIds order", () => {
    const contentIds = ids(over)
    // Reverse the recency: the last id is now the most recent, c1 the oldest.
    const contentRecency = [...contentIds].reverse()
    expect(selectEvictableSurfaces({ contentIds, contentRecency })).toEqual(["c2", "c1"])
  })

  test("never evicts a mounted content, even when it is the LRU", () => {
    const contentIds = ids(over)
    const evicted = selectEvictableSurfaces({
      contentIds,
      contentRecency: contentIds,
      mountedIds: [id(cap + 2)],
    })
    expect(evicted).not.toContain(id(cap + 2))
    // The mounted LRU's slot comes out of the budget, so the next-oldest pair goes instead.
    expect(evicted).toEqual([id(cap), id(cap + 1)])
  })

  test("never evicts a pinned content", () => {
    const contentIds = ids(over)
    const evicted = selectEvictableSurfaces({
      contentIds,
      contentRecency: contentIds,
      pinnedIds: [id(cap + 1)],
    })
    expect(evicted).not.toContain(id(cap + 1))
    expect(evicted).toEqual([id(cap), id(cap + 2)])
  })

  test("exempt contents consume the budget rather than sitting on top of it", () => {
    const contentIds = ids(over)
    const mountedIds = contentIds.filter((_, index) => index >= over - 4) // the 4 oldest
    const evicted = selectEvictableSurfaces({
      contentIds,
      contentRecency: contentIds,
      mountedIds,
    })
    // 4 mounted + kept = the cap exactly.
    expect(contentIds.length - evicted.length).toBe(MAX_OPEN_SURFACES)
    for (const value of mountedIds) expect(evicted).not.toContain(value)
  })

  test("evicts everything evictable when exemptions alone fill the budget", () => {
    const contentIds = ids(over)
    const mountedIds = contentIds.slice(0, cap)
    expect(selectEvictableSurfaces({ contentIds, contentRecency: contentIds, mountedIds })).toEqual([
      id(cap + 1),
      id(cap + 2),
    ])
  })

  test("an id missing from recency is treated as the oldest", () => {
    const contentIds = ids(over)
    // c3 never made it into contentRecency — the least trustworthy entry, so it
    // goes before the second-to-last id despite sitting near the front of contentIds.
    const contentRecency = contentIds.filter((value) => value !== "c3")
    const evicted = selectEvictableSurfaces({ contentIds, contentRecency })
    expect(evicted).toEqual([id(cap + 2), "c3"])
    expect(evicted).not.toContain(id(cap + 1))
  })

  test("counts a duplicated contentId once", () => {
    const contentIds = [...ids(cap), id(cap)]
    expect(selectEvictableSurfaces({ contentIds, contentRecency: ids(cap) })).toEqual([])
  })

  test("honours an explicit max", () => {
    const contentIds = ids(5)
    expect(selectEvictableSurfaces({ contentIds, contentRecency: contentIds, max: 2 })).toEqual(["c3", "c4", "c5"])
  })
})
