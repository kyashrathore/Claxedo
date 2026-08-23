import { describe, expect, test } from "bun:test"
import { currentComparisons, currentComparisonsFor, publicComparisons } from "../src/content/competitors"

describe("comparison pages", () => {
  test("generates routes only for current and expired records", () => {
    expect(publicComparisons.every((item) => item.status !== "draft")).toBe(true)
    expect(currentComparisons).toHaveLength(6)
  })

  test("expires otherwise-current records after their review date", () => {
    expect(currentComparisonsFor(publicComparisons, "2026-09-24")).toHaveLength(0)
    expect(currentComparisonsFor(publicComparisons, "2026-09-23")).toHaveLength(6)
  })

  test("requires visible review metadata and first-party sources", () => {
    expect(currentComparisons.every((item) => item.owner && item.sources.length >= 2)).toBe(true)
  })
})
