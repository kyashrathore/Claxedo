import { describe, expect, test } from "bun:test"
import { competitors, currentComparisonsFor, publicComparisons } from "../src/content/competitors"

// As of the records' own latest review, never the wall clock — see the
// rationale in comparison-pages.test.ts (run 380's calendar-driven red).
const asOfLatestReview = publicComparisons.map((competitor) => competitor.lastReviewed).sort().at(-1)!
const reviewedComparisons = currentComparisonsFor(publicComparisons, asOfLatestReview)

describe("competitor contract", () => {
  test("publishes the six reviewed launch comparisons", () => {
    expect(reviewedComparisons.map((competitor) => competitor.slug)).toEqual([
      "paseo",
      "synara",
      "conductor",
      "superset",
      "t3-code",
      "opencode",
    ])
  })

  test("requires unique slugs and complete review metadata", () => {
    expect(new Set(competitors.map((competitor) => competitor.slug)).size).toBe(competitors.length)
    expect(
      publicComparisons.every(
        (competitor) =>
          competitor.owner &&
          competitor.lastReviewed &&
          competitor.nextReview >= competitor.lastReviewed &&
          competitor.sources.length > 0 &&
          competitor.sources.every((source) => new URL(source.href).protocol === "https:"),
      ),
    ).toBe(true)
  })

  test("keeps comparison conclusions narrower than sourced facts", () => {
    expect(
      publicComparisons.every(
        (competitor) =>
          competitor.verdict.length > 0 &&
          competitor.genuineEdge.length >= 2 &&
          competitor.claxedoDiffers.length >= 2 &&
          competitor.chooseThem.length > 0 &&
          competitor.chooseClaxedo.length > 0,
      ),
    ).toBe(true)
  })
})
