import { describe, expect, test } from "bun:test"
import { formatQuoteNote, parseCommentNote, parseImageMarkNote, parseQuoteNote, type QuoteNote } from "./comment-note"

describe("quote notes", () => {
  const cases: QuoteNote[] = [
    { source: { kind: "conversation" }, quote: "Run the migration first.", comment: "Why first?" },
    { source: { kind: "plan" }, quote: "Step one\n\nStep two", comment: "Swap these" },
    { source: { kind: "file", path: "docs/guide notes.md" }, quote: "> already quoted\nnext", comment: "line one\n\n> line three" },
  ]

  for (const note of cases) {
    test(`round-trips a ${note.source.kind} excerpt`, () => {
      expect(parseQuoteNote(formatQuoteNote(note))).toEqual(note)
    })
  }

  test("tells the agent where the excerpt came from and quotes every line", () => {
    const text = formatQuoteNote({ source: { kind: "file", path: "README.md" }, quote: "  a\n\nb  ", comment: "c" })
    expect(text).toBe("The user made the following comment regarding this excerpt from the file README.md:\n> a\n>\n> b\n\nc")
  })

  test("is never read as a line comment or an image mark", () => {
    const text = formatQuoteNote({ source: { kind: "conversation" }, quote: "q", comment: "c" })
    expect(parseCommentNote(text)).toBeUndefined()
    expect(parseImageMarkNote(text)).toBeUndefined()
  })

  test("reads no quote from a line comment", () => {
    expect(parseQuoteNote("The user made the following comment regarding line 4 of a.ts: why")).toBeUndefined()
  })
})
