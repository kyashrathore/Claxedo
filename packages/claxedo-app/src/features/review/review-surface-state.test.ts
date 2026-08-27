import { describe, expect, test } from "bun:test"

import {
  cloneReviewSurfaceState,
  restoredOpenDiffs,
  type ReviewSurfaceState,
} from "./review-surface-state"

describe("review surface state", () => {
  test("clones the arrays a caller could mutate after publishing", () => {
    const state: ReviewSurfaceState = {
      mode: "to-from",
      fromRef: "main",
      toRef: "HEAD",
      diffStyle: "split",
      openDiffs: ["src/a.ts"],
      focusedFile: "src/a.ts",
      forcedDiffPaths: ["src/huge.ts"],
    }

    const clone = cloneReviewSurfaceState(state)
    state.openDiffs!.push("src/b.ts")
    state.forcedDiffPaths!.push("src/other.ts")

    expect(clone.openDiffs).toEqual(["src/a.ts"])
    expect(clone.forcedDiffPaths).toEqual(["src/huge.ts"])
    expect(clone.mode).toBe("to-from")
    expect(clone.fromRef).toBe("main")
    expect(clone.toRef).toBe("HEAD")
    expect(clone.diffStyle).toBe("split")
    expect(clone.focusedFile).toBe("src/a.ts")
  })
})

describe("restored open diffs", () => {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"]

  test("falls back to the focused file alone when nothing is retained", () => {
    expect(restoredOpenDiffs({ files })).toEqual([])
    expect(restoredOpenDiffs({ files, focused: "src/b.ts" })).toEqual(["src/b.ts"])
  })

  test("reopens the retained rows that the reloaded changeset still has", () => {
    expect(restoredOpenDiffs({ files, retained: ["src/c.ts", "src/gone.ts", "src/a.ts"] }))
      .toEqual(["src/c.ts", "src/a.ts"])
  })

  test("drops a retained set whose files are all gone", () => {
    expect(restoredOpenDiffs({ files, retained: ["src/gone.ts"], focused: "src/a.ts" }))
      .toEqual(["src/a.ts"])
  })

  test("adds the focused file to the retained rows without duplicating it", () => {
    expect(restoredOpenDiffs({ files, retained: ["src/a.ts"], focused: "src/b.ts" }))
      .toEqual(["src/a.ts", "src/b.ts"])
    expect(restoredOpenDiffs({ files, retained: ["src/a.ts"], focused: "src/a.ts" }))
      .toEqual(["src/a.ts"])
    // A focused file the changeset no longer has must not be opened.
    expect(restoredOpenDiffs({ files, retained: ["src/a.ts"], focused: "src/gone.ts" }))
      .toEqual(["src/a.ts"])
  })
})
