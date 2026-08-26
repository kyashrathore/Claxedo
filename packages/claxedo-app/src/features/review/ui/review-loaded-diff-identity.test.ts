import { describe, expect, test } from "bun:test"
import { reviewLoadedDiffIdentity } from "./review-loaded-diff-identity"

describe("reviewLoadedDiffIdentity", () => {
  test("is order-independent but binds every exact canonical path", () => {
    const expected = reviewLoadedDiffIdentity(["src/c.ts", "src/a.ts", "src/b.ts"])

    expect(reviewLoadedDiffIdentity(["src/b.ts", "src/c.ts", "src/a.ts"])).toBe(expected)
    expect(reviewLoadedDiffIdentity(["src/a.ts", "src/b.ts", "src/d.ts"])).not.toBe(expected)
  })

  test("does not let a duplicate replace a missing identity", () => {
    expect(reviewLoadedDiffIdentity(["src/a.ts", "src/a.ts", "src/c.ts"]))
      .not.toBe(reviewLoadedDiffIdentity(["src/a.ts", "src/b.ts", "src/c.ts"]))
  })
})
