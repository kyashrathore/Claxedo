import { describe, expect, test } from "bun:test"
import { competitors, currentComparisons, publicComparisons } from "../src/content/competitors"

describe("competitor contract", () => {
  test("publishes the six reviewed launch comparisons", () => {
    expect(currentComparisons.map((competitor) => competitor.slug)).toEqual([
      "matrix-os",
      "omnigent",
      "paseo",
      "openhands",
      "t3-code",
      "hermes-agent",
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
        (competitor) => competitor.boundary.length > 0 && competitor.overlap.length > 0 && competitor.facts.length >= 2,
      ),
    ).toBe(true)
  })
})
