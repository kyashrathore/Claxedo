import { describe, expect, test } from "bun:test"
import type { AgentSnapshotFileDiff as SnapshotFileDiff } from "@claxedo/agent-runtime-contract"
import { uniqueSummaryDiffs } from "./message-timeline.data"

// Ported from upstream packages/app/src/pages/session/timeline/summary-diffs.test.ts (#37414).
// Captures both the ordering semantics and the linear-time requirement.

function diff(file: string | undefined, additions = 0): SnapshotFileDiff {
  return { file, additions, deletions: 0, status: "modified" } as SnapshotFileDiff
}

describe("uniqueSummaryDiffs", () => {
  test("drops diffs without a file path", () => {
    const alpha = diff("alpha.ts", 1)
    const beta = diff("beta.ts", 2)
    const invalid = diff(undefined)

    expect(uniqueSummaryDiffs([])).toEqual([])
    expect(uniqueSummaryDiffs([invalid])).toEqual([])

    const result = uniqueSummaryDiffs([alpha, invalid, beta])
    expect(result).toEqual([alpha, beta])
    expect(result[0]).toBe(alpha)
    expect(result[1]).toBe(beta)
  })

  test("keeps the last diff per file in the legacy display order", () => {
    const oldAlpha = diff("alpha.ts", 1)
    const oldBeta = diff("beta.ts", 1)
    const newAlpha = diff("alpha.ts", 2)
    const charlie = diff("charlie.ts", 1)
    const newBeta = diff("beta.ts", 2)

    const result = uniqueSummaryDiffs([oldAlpha, oldBeta, newAlpha, charlie, newBeta])

    expect(result).toEqual([newAlpha, charlie, newBeta])
    expect(result[0]).toBe(newAlpha)
    expect(result[1]).toBe(charlie)
    expect(result[2]).toBe(newBeta)
  })

  test("deduplicates large summaries with bounded file-path reads", () => {
    let fileReads = 0
    const input = Array.from({ length: 50_000 }, (_, index) => ({
      ...diff(`file_${index % 500}.ts`, index),
      get file() {
        fileReads += 1
        return `file_${index % 500}.ts`
      },
    }))

    const result = uniqueSummaryDiffs(input)

    // A scan of prior results for each input repeatedly reads those paths.
    // Count that work directly so machine load cannot change the verdict.
    expect(fileReads).toBeLessThanOrEqual(input.length * 3)
    expect(result).toEqual(input.slice(-500))
    expect(result.every((item, index) => item === input[49_500 + index])).toBe(true)
  })
})
