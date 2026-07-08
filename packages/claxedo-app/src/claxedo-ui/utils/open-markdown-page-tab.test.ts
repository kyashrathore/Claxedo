import { describe, expect, test } from "bun:test"
import { isMarkdownPath, markdownPathFromHref } from "./open-markdown-page-tab"

describe("open markdown page tab utilities", () => {
  test("recognizes markdown file extensions", () => {
    expect(isMarkdownPath("notes.md")).toBe(true)
    expect(isMarkdownPath("notes.markdown")).toBe(true)
    expect(isMarkdownPath("notes.mdown")).toBe(true)
    expect(isMarkdownPath("notes.txt")).toBe(false)
  })

  test("extracts markdown paths from relative and file links", () => {
    expect(markdownPathFromHref("./docs/../README.md?view=edit#intro")).toBe("README.md")
    expect(markdownPathFromHref("file:///repo/docs/page.markdown#section")).toBe("/repo/docs/page.markdown")
  })

  test("keeps Windows drive paths path-like", () => {
    expect(markdownPathFromHref("C:\\repo\\notes\\page.md")).toBe("C:/repo/notes/page.md")
    expect(markdownPathFromHref("https://example.test/page.md")).toBe("")
  })
})
