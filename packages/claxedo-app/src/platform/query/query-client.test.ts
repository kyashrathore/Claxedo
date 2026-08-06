import { describe, expect, test } from "bun:test"
import { QUERY_CACHE_GC_TIME_MS, queryClient } from "./query-client"

describe("query client retention", () => {
  test("garbage-collects inactive queries within the renderer retention budget", () => {
    expect(QUERY_CACHE_GC_TIME_MS).toBe(30 * 60 * 1000)
    expect(queryClient.getDefaultOptions().queries?.gcTime).toBe(QUERY_CACHE_GC_TIME_MS)
  })
})
