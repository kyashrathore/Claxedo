import { describe, expect, test } from "bun:test"
import { MAX_OPEN_SURFACES, selectEvictableSurfaces } from "./surface-budget"

const ids = (count: number, prefix = "c") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`)

describe("state/surface-budget", () => {
  test("evicts nothing while at or under budget", () => {
    const contentIds = ids(MAX_OPEN_SURFACES)
    expect(
      selectEvictableSurfaces({ contentIds, contentRecency: contentIds }),
    ).toEqual([])
  })

  test("evicts the least-recently-used surfaces past the cap", () => {
    // Recency is MRU-first, so c1 is the newest and c12 the oldest.
    const contentIds = ids(12)
    expect(
      selectEvictableSurfaces({ contentIds, contentRecency: contentIds }),
    ).toEqual(["c11", "c12"])
  })

  test("recency order wins over contentIds order", () => {
    const contentIds = ids(12)
    // Reverse the recency: c12 is now the most recent, c1 the oldest.
    const contentRecency = [...contentIds].reverse()
    expect(
      selectEvictableSurfaces({ contentIds, contentRecency }),
    ).toEqual(["c2", "c1"])
  })

  test("never evicts a mounted content, even when it is the LRU", () => {
    const contentIds = ids(12)
    const evicted = selectEvictableSurfaces({
      contentIds,
      contentRecency: contentIds,
      mountedIds: ["c12"],
    })
    expect(evicted).not.toContain("c12")
    // c12's slot comes out of the budget, so the next-oldest pair goes instead.
    expect(evicted).toEqual(["c10", "c11"])
  })

  test("never evicts a pinned content", () => {
    const contentIds = ids(12)
    const evicted = selectEvictableSurfaces({
      contentIds,
      contentRecency: contentIds,
      pinnedIds: ["c11"],
    })
    expect(evicted).not.toContain("c11")
    expect(evicted).toEqual(["c10", "c12"])
  })

  test("exempt contents consume the budget rather than sitting on top of it", () => {
    const contentIds = ids(12)
    const mountedIds = ids(12).slice(0, 12).filter((_, index) => index >= 8) // c9..c12
    const evicted = selectEvictableSurfaces({
      contentIds,
      contentRecency: contentIds,
      mountedIds,
    })
    // 4 mounted + 6 kept = the 10-surface cap exactly.
    expect(contentIds.length - evicted.length).toBe(MAX_OPEN_SURFACES)
    for (const id of mountedIds) expect(evicted).not.toContain(id)
  })

  test("evicts everything evictable when exemptions alone fill the budget", () => {
    const contentIds = ids(12)
    const mountedIds = contentIds.slice(0, 10)
    expect(
      selectEvictableSurfaces({ contentIds, contentRecency: contentIds, mountedIds }),
    ).toEqual(["c11", "c12"])
  })

  test("an id missing from recency is treated as the oldest", () => {
    const contentIds = ids(12)
    // c3 never made it into contentRecency — the least trustworthy entry, so it
    // goes before c11 despite sitting near the front of contentIds.
    const contentRecency = contentIds.filter((id) => id !== "c3")
    const evicted = selectEvictableSurfaces({ contentIds, contentRecency })
    expect(evicted).toEqual(["c12", "c3"])
    expect(evicted).not.toContain("c11")
  })

  test("counts a duplicated contentId once", () => {
    const contentIds = [...ids(10), "c10"]
    expect(
      selectEvictableSurfaces({ contentIds, contentRecency: ids(10) }),
    ).toEqual([])
  })

  test("honours an explicit max", () => {
    const contentIds = ids(5)
    expect(
      selectEvictableSurfaces({ contentIds, contentRecency: contentIds, max: 2 }),
    ).toEqual(["c3", "c4", "c5"])
  })
})
