import { describe, expect, spyOn, test } from "bun:test"
import { MarkdownManager } from "@tiptap/markdown"
import type { JSONContent } from "@tiptap/core"
import {
  MARKDOWN_MAX_BYTES,
  RICH_MARKDOWN_MAX_BYTES,
  detectMarkdown,
  serializeMarkdownDocument,
  type RichMarkdown,
} from "./detector"

describe("Markdown fidelity", () => {
  /**
   * Documents edits a user's file, so anything the serializer would rewrite
   * opens in source mode. An app-owned record has no such promise to keep.
   */
  const normalized = ["* item", "__bold__", "1) x", "- a\n\n- b", "a | b\n--|--"]

  test("exact mode keeps every document the serializer would reformat in source mode", () => {
    for (const markdown of normalized) {
      const result = detectMarkdown(markdown)
      expect(result.status, markdown).toBe("source")
      if (result.status === "source") expect(result.reason.code, markdown).toBe("roundtrip_mismatch")
    }
  })

  test("normalizing mode opens the same documents rich", () => {
    for (const markdown of normalized) {
      expect(detectMarkdown(markdown, "normalizing").status, markdown).toBe("rich")
    }
  })

  test("exact is the default, so a caller that says nothing gets the byte-stable gate", () => {
    expect(detectMarkdown("* item").status).toBe("source")
  })

  // Relaxing the round-trip check is not relaxing the contract: what the
  // editor cannot represent at all is still refused in both modes.
  test("syntax outside the contract stays in source mode however forgiving the caller is", () => {
    for (const markdown of ["<div>html</div>", "text[^1]", "$$x$$", "[ref]: https://example.com"]) {
      expect(detectMarkdown(markdown, "normalizing").status, markdown).toBe("source")
      expect(detectMarkdown(markdown).status, markdown).toBe("source")
    }
  })

  test("the size limits gate both modes", () => {
    const large = "a".repeat(RICH_MARKDOWN_MAX_BYTES + 1)
    expect(detectMarkdown(large, "normalizing").status).toBe("source")
    expect(detectMarkdown("a".repeat(MARKDOWN_MAX_BYTES + 1), "normalizing").status).toBe("rejected")
  })

  test("a CRLF body is not byte-stable in either mode", () => {
    expect(detectMarkdown("a\r\nb", "normalizing").status).toBe("source")
  })
})

describe("Markdown rich-mode detector", () => {
  test("round-trips a supported document without changing its bytes", () => {
    const markdown = "\uFEFF---\ntitle: Detector contract\n---\n# Heading\n\nA **supported** paragraph."
    const result = detectMarkdown(markdown)

    expect(result.status).toBe("rich")
    if (result.status !== "rich") return
    expect(serializedMarkdown(result.document, result.envelope)).toBe(markdown)
  })

  test("sends CRLF body content to source mode with a stable reason", () => {
    const result = detectMarkdown("# Heading\r\n\r\nBody\r\n")

    expect(result.status).toBe("source")
    if (result.status !== "source") return
    expect(result.reason.code).toBe("crlf_body")
  })

  test("rejects invalid UTF-8 before parsing", () => {
    const result = detectMarkdown(new Uint8Array([0xc3, 0x28]))

    expect(result).toEqual({
      status: "rejected",
      reason: {
        code: "document_not_text",
        message: "The document is not valid UTF-8 text.",
      },
      bytes: 2,
    })
  })

  test("preserves a UTF-8 BOM supplied as bytes", () => {
    const result = detectMarkdown(new TextEncoder().encode("\uFEFF# Heading"))

    expect(result.status).toBe("rich")
    if (result.status !== "rich") return
    expect(serializedMarkdown(result.document, result.envelope)).toBe("\uFEFF# Heading")
  })

  test("rejects NUL bytes as non-text content", () => {
    const result = detectMarkdown("valid before\0valid after")

    expect(result.status).toBe("rejected")
    if (result.status !== "rejected") return
    expect(result.reason.code).toBe("document_not_text")
  })

  test("gives non-text NUL content precedence over the hard size limit", () => {
    const markdown = "\0" + "a".repeat(MARKDOWN_MAX_BYTES + 1)

    for (const input of [markdown, new TextEncoder().encode(markdown)]) {
      const result = detectMarkdown(input)
      expect(result.status).toBe("rejected")
      if (result.status !== "rejected") continue
      expect(result.reason.code).toBe("document_not_text")
    }
  })

  test("routes documents above 512 KiB to source and rejects documents above 2 MiB", () => {
    const richBoundary = detectMarkdown("a".repeat(RICH_MARKDOWN_MAX_BYTES))
    const source = detectMarkdown("a".repeat(RICH_MARKDOWN_MAX_BYTES + 1))
    const hardBoundary = detectMarkdown("a".repeat(MARKDOWN_MAX_BYTES))
    const rejected = detectMarkdown("a".repeat(MARKDOWN_MAX_BYTES + 1))

    expect(richBoundary.status).toBe("rich")
    expect(source.status).toBe("source")
    if (source.status === "source") expect(source.reason.code).toBe("rich_limit_exceeded")
    expect(hardBoundary.status).toBe("source")
    if (hardBoundary.status === "source") expect(hardBoundary.reason.code).toBe("rich_limit_exceeded")
    expect(rejected.status).toBe("rejected")
    if (rejected.status === "rejected") expect(rejected.reason.code).toBe("document_too_large")
  })

  test("keeps empty, whitespace-only, missing-newline, and NFD text byte-exact", () => {
    for (const markdown of ["", " \n", "No trailing newline", "Cafe\u0301"]) {
      const result = detectMarkdown(markdown)

      expect(result.status).toBe("rich")
      if (result.status !== "rich") continue
      expect(serializedMarkdown(result.document, result.envelope)).toBe(markdown)
    }
  })

  test("keeps a two-space hard break byte-exact", () => {
    const markdown = "First line  \nsecond line"
    const result = detectMarkdown(markdown)

    expect(result.status).toBe("rich")
    if (result.status !== "rich") return
    expect(serializedMarkdown(result.document, result.envelope)).toBe(markdown)
  })

  test("above the rich size limit, returns before invoking the parser", () => {
    const parse = spyOn(MarkdownManager.prototype, "parse")
    try {
      expect(detectMarkdown("# Probe").status).toBe("rich")
      expect(parse).toHaveBeenCalledTimes(1)
      parse.mockClear()
      expect(detectMarkdown("a".repeat(RICH_MARKDOWN_MAX_BYTES + 1)).status).toBe("source")
      expect(detectMarkdown("a".repeat(MARKDOWN_MAX_BYTES)).status).toBe("source")
      expect(detectMarkdown("a".repeat(MARKDOWN_MAX_BYTES + 1)).status).toBe("rejected")
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  test("keeps supported 100 KiB and 500 KiB parsing within the coarse CI budget", () => {
    const startedAt = performance.now()
    expect(detectMarkdown("a".repeat(100 * 1024)).status).toBe("rich")
    expect(detectMarkdown("a".repeat(500 * 1024)).status).toBe("rich")
    expect(performance.now() - startedAt).toBeLessThan(3_000)
  })

  test("bounds pathological blockquote and nested-list parsing", () => {
    const startedAt = performance.now()
    const blockquote = detectMarkdown(">".repeat(5_000) + " text")
    const nestedList = detectMarkdown(
      Array.from({ length: 700 }, (_, index) => "  ".repeat(index) + "- item").join("\n"),
    )

    expect(blockquote.status).toBe("source")
    if (blockquote.status === "source") expect(blockquote.reason.code).toBe("parser_failed")
    expect(nestedList.status).toBe("source")
    if (nestedList.status === "source") expect(nestedList.reason.code).toBe("complexity_limit_exceeded")
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  test("preserves the original trailing-newline policy after a rich edit", () => {
    for (const markdown of ["Before\n", "Before"]) {
      const result = detectMarkdown(markdown)
      expect(result.status).toBe("rich")
      if (result.status !== "rich") continue
      const document = structuredClone(result.document)
      const text = document.content?.[0]?.content?.[0]
      if (text) text.text = "After"

      expect(serializedMarkdown(document, result.envelope)).toBe(markdown.endsWith("\n") ? "After\n" : "After")
    }
  })

  test("serializes a deleted body to zero bytes instead of a newline", () => {
    const result = detectMarkdown("Delete me\n")
    expect(result.status).toBe("rich")
    if (result.status !== "rich") return

    expect(serializedMarkdown({ type: "doc", content: [] }, result.envelope)).toBe("")
  })

  test("a &nbsp;-poisoned document with uneven blank runs stays in source mode", () => {
    // Real-world shape produced by earlier rich-mode saves: an `&nbsp;` line
    // (serializer artifact for adjacent empty paragraphs) plus 3-newline blank
    // runs, neither of which the pinned serializer can reproduce byte-exactly.
    const poisoned = "\n\n# Hello every\n\n\n\n&nbsp;\n\n## hi\n\n"
    const result = detectMarkdown(poisoned)

    expect(result.status).toBe("source")
    if (result.status !== "source") return
    expect(result.reason.code).toBe("roundtrip_mismatch")
  })

  test("the same document reaches rich mode once the poison is edited out", () => {
    // The manual source-mode fix: delete the `&nbsp;` line and collapse blank
    // runs to single blank lines. This must round-trip byte-exactly.
    const cleaned = "# Hello every\n\n## hi\n"
    const result = detectMarkdown(cleaned)

    expect(result.status).toBe("rich")
    if (result.status !== "rich") return
    expect(serializedMarkdown(result.document, result.envelope)).toBe(cleaned)
  })

  test("returns a stable source result when the external serializer throws", () => {
    const result = detectMarkdown("Original")
    expect(result.status).toBe("rich")
    if (result.status !== "rich") return
    const cyclic = { type: "doc", content: [] } satisfies JSONContent
    cyclic.content.push(cyclic)

    const serialized = serializeMarkdownDocument(cyclic, result.envelope)
    expect(serialized.status).toBe("source")
    if (serialized.status !== "source") return
    expect(serialized.reason.code).toBe("parser_failed")
  })
})

function serializedMarkdown(document: JSONContent, envelope: RichMarkdown["envelope"]) {
  const result = serializeMarkdownDocument(document, envelope)
  expect(result.status).toBe("serialized")
  return result.status === "serialized" ? result.markdown : ""
}
