import { describe, expect, test } from "bun:test"
import { markdownTableText } from "./markdown-table"

function table(rows: string[][]) {
  return {
    rows: rows.map((cells) => ({
      cells: cells.map((text) => ({ innerText: text, textContent: text })),
    })),
  }
}

describe("markdownTableText", () => {
  test("preserves rows and columns for spreadsheet paste", () => {
    const subject = table([
      ["Harness", "Provider quota"],
      ["codex-acp", "Available today"],
      ["cursor-sdk", "Detailed\n usage"],
    ])

    expect(markdownTableText(subject)).toBe(
      "Harness\tProvider quota\ncodex-acp\tAvailable today\ncursor-sdk\tDetailed usage",
    )
  })

  test("normalizes tabs inside a cell without changing the table shape", () => {
    expect(markdownTableText(table([["one\ttwo", "three"]]))).toBe("one two\tthree")
  })
})
