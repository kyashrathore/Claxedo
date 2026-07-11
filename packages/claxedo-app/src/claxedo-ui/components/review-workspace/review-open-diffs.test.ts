import { describe, expect, test } from "bun:test"
import {
  INITIAL_REVIEW_OPEN_DIFF_LIMIT,
  REVIEW_OPEN_DIFF_BATCH,
  expandReviewOpenDiffsForScroll,
  initialReviewOpenDiffs,
} from "./review-open-diffs"

describe("initialReviewOpenDiffs", () => {
  test("opens a viewport-sized first batch by default", () => {
    const files = Array.from({ length: INITIAL_REVIEW_OPEN_DIFF_LIMIT + 12 }, (_, index) => `src/file-${index}.ts`)

    expect(initialReviewOpenDiffs(files)).toEqual(files.slice(0, INITIAL_REVIEW_OPEN_DIFF_LIMIT))
  })

  test("keeps an in-list focus target open beyond the first batch", () => {
    const files = Array.from({ length: INITIAL_REVIEW_OPEN_DIFF_LIMIT + 12 }, (_, index) => `src/file-${index}.ts`)

    expect(initialReviewOpenDiffs(files, files.at(-1))).toEqual([
      ...files.slice(0, INITIAL_REVIEW_OPEN_DIFF_LIMIT),
      files.at(-1)!,
    ])
  })

  test("keeps a missing focus target open with the changed files", () => {
    const files = Array.from({ length: INITIAL_REVIEW_OPEN_DIFF_LIMIT + 2 }, (_, index) => `src/file-${index}.ts`)

    expect(initialReviewOpenDiffs(files, "src/missing.ts")).toEqual([
      ...files.slice(0, INITIAL_REVIEW_OPEN_DIFF_LIMIT),
      "src/missing.ts",
    ])
  })
})

describe("expandReviewOpenDiffsForScroll", () => {
  test("keeps current batch when scroll is not near the rendered end", () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts`)
    const open = initialReviewOpenDiffs(files)

    expect(expandReviewOpenDiffsForScroll({
      files,
      open,
      scrollTop: 100,
      clientHeight: 400,
      scrollHeight: 4000,
    })).toBe(open)
  })

  test("opens the next batch near the rendered end", () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts`)
    const open = initialReviewOpenDiffs(files)

    expect(expandReviewOpenDiffsForScroll({
      files,
      open,
      scrollTop: 3200,
      clientHeight: 400,
      scrollHeight: 4000,
    })).toEqual(files.slice(0, INITIAL_REVIEW_OPEN_DIFF_LIMIT + REVIEW_OPEN_DIFF_BATCH))
  })

  test("preserves focused files while opening the next batch", () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts`)
    const open = initialReviewOpenDiffs(files, files.at(-1))

    expect(expandReviewOpenDiffsForScroll({
      files,
      open,
      scrollTop: 3200,
      clientHeight: 400,
      scrollHeight: 4000,
    })).toEqual([
      ...files.slice(0, INITIAL_REVIEW_OPEN_DIFF_LIMIT + REVIEW_OPEN_DIFF_BATCH),
      files.at(-1)!,
    ])
  })
})
