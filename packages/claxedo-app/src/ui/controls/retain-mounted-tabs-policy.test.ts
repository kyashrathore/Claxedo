import { describe, expect, test } from "bun:test"
import { retainMountedTabsPolicy } from "./retain-mounted-tabs-policy"

// Decides which previously-mounted tab surfaces stay mounted (kept warm) after
// a change: the active tab is always retained, dead surfaces are dropped, and
// an optional limit evicts the oldest non-active surfaces first.

const live = (...ids: string[]) => new Set(ids)

describe("retainMountedTabsPolicy", () => {
  test("drops mounted ids that are no longer live", () => {
    expect(retainMountedTabsPolicy({ mounted: ["a", "b", "c"], activeId: undefined, liveIds: live("a", "c") })).toEqual(
      ["a", "c"],
    )
  })

  test("adds the active id when it was not already mounted (and it is live)", () => {
    expect(retainMountedTabsPolicy({ mounted: ["a"], activeId: "b", liveIds: live("a", "b") })).toEqual(["a", "b"])
  })

  test("does not resurrect an active id that is not live", () => {
    expect(retainMountedTabsPolicy({ mounted: ["a"], activeId: "b", liveIds: live("a") })).toEqual(["a"])
  })

  test("keeps everything when under or at the limit", () => {
    expect(retainMountedTabsPolicy({ mounted: ["a", "b"], activeId: "b", liveIds: live("a", "b"), limit: 2 })).toEqual([
      "a",
      "b",
    ])
  })

  test("evicts the oldest non-active surfaces first, always keeping the active one last", () => {
    expect(
      retainMountedTabsPolicy({
        mounted: ["a", "b", "c", "d"],
        activeId: "b",
        liveIds: live("a", "b", "c", "d"),
        limit: 2,
      }),
    ).toEqual(["d", "b"])
  })

  test("with no active id, keeps the most-recent `limit` live surfaces", () => {
    expect(
      retainMountedTabsPolicy({
        mounted: ["a", "b", "c", "d"],
        activeId: undefined,
        liveIds: live("a", "b", "c", "d"),
        limit: 2,
      }),
    ).toEqual(["c", "d"])
  })

  test("a non-positive limit is treated as no limit", () => {
    expect(
      retainMountedTabsPolicy({ mounted: ["a", "b", "c"], activeId: "a", liveIds: live("a", "b", "c"), limit: 0 }),
    ).toEqual(["a", "b", "c"])
  })
})
