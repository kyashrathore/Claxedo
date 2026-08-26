import { describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"
import { createHistoryMetaState, historyHasMore, historyIsLoading } from "./history-pagination"

describe("history pagination meta state", () => {
  test("starts empty and records field values by key", () => {
    createRoot((dispose) => {
      const { meta, setValue } = createHistoryMetaState()
      expect(meta()).toEqual({ limit: {}, cursor: {}, failedCursor: {}, complete: {}, loading: {} })

      flush(() => {
        setValue("cursor", "k1", "cur_1")
        setValue("limit", "k1", 80)
      })
      expect(meta().cursor.k1).toBe("cur_1")
      expect(meta().limit.k1).toBe(80)
      // Other keys stay untouched.
      expect(meta().cursor.k2).toBeUndefined()
      dispose()
    })
  })

  test("is a persistent update: identical writes do not allocate a new snapshot", () => {
    createRoot((dispose) => {
      const { meta, setValue } = createHistoryMetaState()
      flush(() => setValue("loading", "k1", true))
      const first = meta()
      flush(() => setValue("loading", "k1", true))
      expect(meta()).toBe(first)
      flush(() => setValue("loading", "k1", false))
      expect(meta()).not.toBe(first)
      dispose()
    })
  })

  test("historyHasMore requires a cursor that has not failed and is not complete", () => {
    expect(historyHasMore({ limit: {}, cursor: {}, failedCursor: {}, complete: {}, loading: {} }, "k")).toBe(false)
    expect(historyHasMore({ limit: {}, cursor: { k: "c" }, failedCursor: {}, complete: {}, loading: {} }, "k")).toBe(
      true,
    )
    // The cursor that last failed is dampened (no refetch loop).
    expect(
      historyHasMore({ limit: {}, cursor: { k: "c" }, failedCursor: { k: "c" }, complete: {}, loading: {} }, "k"),
    ).toBe(false)
    // A completed history has no more pages.
    expect(
      historyHasMore({ limit: {}, cursor: { k: "c" }, failedCursor: {}, complete: { k: true }, loading: {} }, "k"),
    ).toBe(false)
  })

  test("historyIsLoading reflects the loading flag for the key", () => {
    expect(historyIsLoading({ limit: {}, cursor: {}, failedCursor: {}, complete: {}, loading: {} }, "k")).toBe(false)
    expect(historyIsLoading({ limit: {}, cursor: {}, failedCursor: {}, complete: {}, loading: { k: true } }, "k")).toBe(
      true,
    )
  })
})
