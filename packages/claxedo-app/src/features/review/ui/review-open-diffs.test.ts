import { describe, expect, test } from "bun:test"
import { initialReviewOpenDiffs } from "./review-open-diffs"

describe("initialReviewOpenDiffs", () => {
  test("seeds every changed file so no rows are hidden", () => {
    const files = Array.from({ length: 16 }, (_, index) => `src/file-${index}.ts`)

    expect(initialReviewOpenDiffs(files)).toEqual(files)
  })

  test("does not duplicate an in-list focus target", () => {
    const files = Array.from({ length: 16 }, (_, index) => `src/file-${index}.ts`)

    expect(initialReviewOpenDiffs(files, files.at(-1))).toEqual(files)
  })

  test("keeps a missing focus target open alongside the changed files", () => {
    const files = Array.from({ length: 6 }, (_, index) => `src/file-${index}.ts`)

    expect(initialReviewOpenDiffs(files, "src/missing.ts")).toEqual([...files, "src/missing.ts"])
  })
})
