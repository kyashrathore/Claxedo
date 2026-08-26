import { describe, expect, test } from "bun:test"
import { reviewToggleAllAction } from "./review-toggle-all"

describe("reviewToggleAllAction", () => {
  test("offers expand when no diff is open", () => {
    expect(reviewToggleAllAction(0)).toBe("expand")
  })

  test("offers collapse for both partial and fully expanded working sets", () => {
    expect(reviewToggleAllAction(1)).toBe("collapse")
    expect(reviewToggleAllAction(24)).toBe("collapse")
  })
})
