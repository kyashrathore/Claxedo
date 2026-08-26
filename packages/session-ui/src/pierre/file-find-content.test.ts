import { describe, expect, test } from "bun:test"
import { assignFindRanges, fileFindLines, fileFindMatches, fileFindMatchesByLine } from "./file-find-content"

describe("fileFindLines", () => {
  test("one line per rendered row", () => {
    expect(fileFindLines("a\nb\nc")).toEqual(["a", "b", "c"])
  })

  test("a trailing newline ends the last line, it does not begin another", () => {
    expect(fileFindLines("a\nb\n")).toEqual(["a", "b"])
  })

  test("an empty file is one empty line, the row the viewer draws", () => {
    expect(fileFindLines("")).toEqual([""])
  })

  test("interior blank lines are kept, so line numbers stay the file's", () => {
    expect(fileFindLines("a\n\nc")).toEqual(["a", "", "c"])
  })
})

describe("fileFindMatches", () => {
  const lines = ["const alpha = 1", "// ALPHA and alpha", "beta", "alpha"]

  test("counts every match in the file, not only the rows on screen", () => {
    expect(fileFindMatches(lines, "alpha")).toHaveLength(4)
  })

  test("is case-insensitive, matching the rendered-row scan it replaces", () => {
    expect(fileFindMatches(lines, "ALPHA").map((match) => match.line)).toEqual([1, 2, 2, 4])
  })

  test("reports 1-based lines and in-line offsets", () => {
    expect(fileFindMatches(lines, "alpha")[0]).toEqual({ line: 1, start: 6, length: 5 })
    expect(fileFindMatches(lines, "alpha")[2]).toEqual({ line: 2, start: 13, length: 5 })
  })

  test("occurrences inside one line do not overlap", () => {
    expect(fileFindMatches(["aaaa"], "aa").map((match) => match.start)).toEqual([0, 2])
  })

  test("matches never span a line boundary", () => {
    expect(fileFindMatches(["ab", "cd"], "bc")).toEqual([])
  })

  test("an empty query matches nothing", () => {
    expect(fileFindMatches(lines, "")).toEqual([])
  })

  test("the order is file order, so navigation walks the file top to bottom", () => {
    expect(fileFindMatches(lines, "a").map((match) => match.line)).toEqual([1, 1, 2, 2, 2, 2, 2, 3, 4, 4])
  })
})

describe("fileFindMatchesByLine", () => {
  test("groups match indexes under their line, in the order found", () => {
    const matches = fileFindMatches(["alpha alpha", "x", "alpha"], "alpha")
    expect(fileFindMatchesByLine(matches)).toEqual(new Map([[1, [0, 1]], [3, [2]]]))
  })
})

describe("assignFindRanges", () => {
  const matches = fileFindMatches(["alpha alpha", "x", "alpha"], "alpha")
  const byLine = fileFindMatchesByLine(matches)

  test("a rendered row supplies the ranges for its own line, in its own order", () => {
    const assigned = assignFindRanges(matches.length, byLine, [{ line: 1, ranges: ["r0", "r1"] }])
    expect(assigned).toEqual(["r0", "r1", undefined])
  })

  test("a line with no rendered row keeps its matches countable and unpainted", () => {
    const assigned = assignFindRanges(matches.length, byLine, [{ line: 3, ranges: ["r2"] }])
    expect(assigned).toEqual([undefined, undefined, "r2"])
    expect(assigned).toHaveLength(matches.length)
  })

  test("no rendered rows still yields one slot per file match", () => {
    expect(assignFindRanges(matches.length, byLine, [])).toEqual([undefined, undefined, undefined])
  })

  test("a row that yields fewer ranges than the file claims pairs what it has", () => {
    const assigned = assignFindRanges(matches.length, byLine, [{ line: 1, ranges: ["only"] }])
    expect(assigned).toEqual(["only", undefined, undefined])
  })

  test("a rendered row for a line with no match contributes nothing", () => {
    expect(assignFindRanges(matches.length, byLine, [{ line: 2, ranges: ["stray"] }])).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })
})
