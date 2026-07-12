import { describe, expect, test } from "bun:test"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./session-load"

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})
