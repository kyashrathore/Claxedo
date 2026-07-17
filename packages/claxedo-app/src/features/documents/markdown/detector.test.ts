import { describe, expect, test } from "bun:test"
import type { JSONContent } from "@tiptap/core"
import {
  MARKDOWN_MAX_BYTES,
  RICH_MARKDOWN_MAX_BYTES,
  detectMarkdown,
  serializeMarkdownDocument,
  type RichMarkdown,
} from "./detector"

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

  test("keeps the 100 KiB and 500 KiB probes responsive and short-circuits the 2 MiB probe", () => {
    const startedAt = performance.now()
    const small = detectMarkdown("a".repeat(100 * 1024))
    const nearSoftLimit = detectMarkdown("a".repeat(500 * 1024))
    const hardLimit = detectMarkdown("a".repeat(2 * 1024 * 1024))

    expect(small.status).toBe("rich")
    expect(nearSoftLimit.status).toBe("rich")
    expect(hardLimit.status).toBe("source")
    expect(performance.now() - startedAt).toBeLessThan(1_000)
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
