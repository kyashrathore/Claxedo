import { describe, expect, test } from "bun:test"
import { currentComparisonsFor, publicComparisons } from "../src/content/competitors"

// The inventory contract is evaluated as of the records' OWN latest review
// date, never the wall clock: currency is time-based by design (an expired
// page stays published behind an expired banner), so asserting the live
// `currentComparisons` here turns every passed nextReview into a CI failure
// (run 380: all six expired on 2026-08-23 and both unit lanes went red) —
// and, emptied, lets the `.every(...)` checks below pass vacuously. The
// date-driven flip itself is pinned by the fixed-date expiry test.
const asOfLatestReview = publicComparisons.map((item) => item.lastReviewed).sort().at(-1)!
const reviewedComparisons = currentComparisonsFor(publicComparisons, asOfLatestReview)

describe("comparison pages", () => {
  test("generates routes only for current and expired records", () => {
    expect(publicComparisons.every((item) => item.status !== "draft")).toBe(true)
    expect(reviewedComparisons).toHaveLength(6)
  })

  test("expires otherwise-current records after their review date", () => {
    expect(currentComparisonsFor(publicComparisons, "2026-08-23")).toHaveLength(0)
    expect(currentComparisonsFor(publicComparisons, "2026-08-22")).toHaveLength(6)
  })

  test("requires visible review metadata and first-party sources", () => {
    expect(reviewedComparisons.every((item) => item.owner && item.sources.length >= 2)).toBe(true)
  })
})
