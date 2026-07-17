import { describe, expect, test } from "bun:test"
import { joinMarkdownEnvelope, splitMarkdownEnvelope } from "./frontmatter"

describe("markdown envelope", () => {
  test("preserves a BOM and CRLF frontmatter as opaque bytes", () => {
    const markdown = "\uFEFF---\r\ntitle: 'Keep my quotes'\r\ntags: [one, two]\r\n---\r\n# Body\n"
    const envelope = splitMarkdownEnvelope(markdown)

    expect(envelope).toEqual({
      bom: "\uFEFF",
      frontmatter: "---\r\ntitle: 'Keep my quotes'\r\ntags: [one, two]\r\n---\r\n",
      body: "# Body\n",
    })
    expect(joinMarkdownEnvelope(envelope, envelope.body)).toBe(markdown)
  })

  test("keeps one separator line with the opaque frontmatter prefix", () => {
    const markdown = "---\ntitle: Keep the separator\n---\n\n# Body\n"

    expect(splitMarkdownEnvelope(markdown)).toEqual({
      bom: "",
      frontmatter: "---\ntitle: Keep the separator\n---\n\n",
      body: "# Body\n",
    })
  })

  test("handles closing dots, a closing delimiter at EOF, and an unterminated opener", () => {
    expect(splitMarkdownEnvelope("---\ntitle: Dots\n...\n# Body")).toEqual({
      bom: "",
      frontmatter: "---\ntitle: Dots\n...\n",
      body: "# Body",
    })
    expect(splitMarkdownEnvelope("---\ntitle: Frontmatter only\n...")).toEqual({
      bom: "",
      frontmatter: "---\ntitle: Frontmatter only\n...",
      body: "",
    })
    expect(splitMarkdownEnvelope("---\ntitle: Unterminated\n")).toEqual({
      bom: "",
      frontmatter: "",
      body: "---\ntitle: Unterminated\n",
    })
  })
})
