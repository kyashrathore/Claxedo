import type { JSONContent } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { MarkdownManager } from "@tiptap/markdown"
import { TableKit } from "@tiptap/extension-table"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import StarterKit from "@tiptap/starter-kit"
import {
  joinMarkdownEnvelope,
  normalizeSerializedMarkdownBody,
  splitMarkdownEnvelope,
  type MarkdownEnvelope,
} from "./frontmatter"

const manager = new MarkdownManager({
  extensions: [StarterKit, Image, TableKit, TaskList, TaskItem],
})

export const RICH_MARKDOWN_MAX_BYTES = 512 * 1024
export const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024

export type RichMarkdown = {
  status: "rich"
  document: JSONContent
  envelope: MarkdownEnvelope
}

export type SourceMarkdown = {
  status: "source"
  markdown: string
  reason: {
    code:
      | "complexity_limit_exceeded"
      | "crlf_body"
      | "parser_failed"
      | "manual"
      | "rich_limit_exceeded"
      | "roundtrip_mismatch"
      | "unsupported_syntax"
    message: string
  }
}

export type RejectedMarkdown = {
  status: "rejected"
  reason: {
    code: "document_not_text" | "document_too_large"
    message: string
  }
  bytes: number
}

export type MarkdownDetection = RichMarkdown | SourceMarkdown | RejectedMarkdown

export type MarkdownSerialization =
  | {
      status: "serialized"
      markdown: string
    }
  | SourceMarkdown

/**
 * How exactly a caller needs the bytes preserved.
 *
 * `exact` is a file on disk: rich mode is offered only when opening and saving
 * without an edit would write back the same bytes, so Documents never
 * reformats someone's file behind their back, and every syntax the editor
 * cannot render as what it is stays in source mode. `normalizing` is a record
 * the app itself owns, where the first edit rewriting `* item` as `- item` is
 * an acceptable price for editing prose as prose: syntax the parser keeps as
 * literal text is admitted, and only what it would drop or misread stays
 * gated. The size and complexity limits and CRLF gate both.
 */
export type MarkdownFidelity = "exact" | "normalizing"

export function detectMarkdown(
  input: string | Uint8Array,
  fidelity: MarkdownFidelity = "exact",
): MarkdownDetection {
  const decoded = decodeMarkdown(input)
  if (decoded.status === "rejected") return decoded
  const markdown = decoded.markdown
  if (markdown.includes("\0")) {
    return {
      status: "rejected",
      reason: {
        code: "document_not_text",
        message: "The document contains NUL bytes and is not text.",
      },
      bytes: decoded.bytes,
    }
  }
  if (decoded.bytes > MARKDOWN_MAX_BYTES) {
    return {
      status: "rejected",
      reason: {
        code: "document_too_large",
        message: "The document exceeds the 2 MiB content limit.",
      },
      bytes: decoded.bytes,
    }
  }
  if (decoded.bytes > RICH_MARKDOWN_MAX_BYTES) {
    return {
      status: "source",
      markdown,
      reason: {
        code: "rich_limit_exceeded",
        message: "Documents above 512 KiB open in source mode.",
      },
    }
  }
  const envelope = splitMarkdownEnvelope(markdown)
  if (envelope.body.includes("\r\n")) {
    return {
      status: "source",
      markdown,
      reason: {
        code: "crlf_body",
        message: "CRLF body line endings are not byte-stable in rich mode.",
      },
    }
  }
  const unsupported = unsupportedSyntax(envelope.body, fidelity)
  if (unsupported) {
    return {
      status: "source",
      markdown,
      reason: {
        code: "unsupported_syntax",
        message: `${unsupported} is outside the rich Markdown contract.`,
      },
    }
  }
  if (exceedsComplexityLimit(envelope.body)) {
    return {
      status: "source",
      markdown,
      reason: {
        code: "complexity_limit_exceeded",
        message: "The document nesting is too deep for bounded rich-mode parsing.",
      },
    }
  }
  try {
    const document = manager.parse(envelope.body)
    const serialized = serializeMarkdownDocument(document, envelope)
    if (serialized.status === "source") return serialized
    if (fidelity === "normalizing" || serialized.markdown === markdown) {
      return { status: "rich", document, envelope }
    }
  } catch {
    return {
      status: "source",
      markdown,
      reason: {
        code: "parser_failed",
        message: "The rich Markdown parser could not safely process this document.",
      },
    }
  }
  return {
    status: "source",
    markdown,
    reason: {
      code: "roundtrip_mismatch",
      message: "Rich-mode serialization would change bytes outside an edit.",
    },
  }
}

function exceedsComplexityLimit(markdown: string) {
  return markdown.split("\n").some((line) => {
    const item = /^(?<indent>[ \t]*)(?:[-+*]|\d+[.)])[ \t]+/.exec(line)
    if (!item?.groups) return false
    return item.groups.indent.replace(/\t/g, "  ").length > 128
  })
}

/**
 * `lossy` marks what @tiptap/markdown 3.23.4 drops or misreads in a browser:
 * an unknown tag such as `<project>` is parsed as an element and vanishes
 * with its text, an unreferenced link definition vanishes, a footnote's
 * continuation paragraph becomes a code block, and a `=======` conflict line
 * is read as a setext underline and disappears. The rest it keeps as literal
 * text — math, Liquid, braces and `import` lines verbatim, setext headings as
 * ATX — which a normalizing record can absorb.
 */
function unsupportedSyntax(markdown: string, fidelity: MarkdownFidelity) {
  const prose = markdown.replace(CODE_SPANS, "")
  return [
    { name: "Reference links", lossy: true, pattern: /^\s{0,3}\[[^\]\n]+\]:\s*\S|\[[^\]\n]+\]\[[^\]\n]*\]/m },
    { name: "Setext headings", lossy: false, pattern: /^\S.*\n(?:=+|-+)[ \t]*$/m },
    { name: "HTML", lossy: true, pattern: HTML_SPAN },
    { name: "Footnotes", lossy: true, pattern: /\[\^[^\]\n]+\]/ },
    { name: "Math", lossy: false, pattern: /\$\$|(?<!\\)\$(?!\s)(?:[^$\n]|\\\$)+\$/ },
    { name: "Liquid templates", lossy: false, pattern: /\{[{%]-?[\s\S]*?-?[%}]\}/ },
    { name: "MDX modules", lossy: false, pattern: /^(?:import|export)\s/m },
    { name: "Brace expressions", lossy: false, pattern: /\{[\s\S]*?\}/ },
    { name: "Merge conflict markers", lossy: true, pattern: /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m },
  ].find((entry) => (fidelity === "exact" || entry.lossy) && entry.pattern.test(prose))?.name
}

const CODE_SPANS = /^(?<fence>`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\k<fence>[ \t]*(?=\n|$)|$)|(?<tick>`+)[^\n]*?\k<tick>/gm
const HTML_SPAN = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>\n]*>/
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/
const LITERALIZED_SPANS = new RegExp(`${CODE_SPANS.source}|${AUTOLINK.source}|(?<tag>${HTML_SPAN.source})`, "gm")

/**
 * The markdown with every HTML-looking span outside code rewritten as the
 * entity text the rich editor keeps.
 *
 * In a browser @tiptap/markdown 3.23.4 parses `<project>` as an element and
 * drops it with its text, and its serializer writes any `<` it does keep as
 * `&lt;`. Rewriting the span up front hands the editor the text it would have
 * produced itself, so a placeholder or a generic such as `Map<K, V>` survives
 * as prose; the HTML gate above then has nothing to find. Code spans and
 * fences are the parser's own to keep verbatim, and an autolink is left for
 * it to turn into a link.
 */
export function literalizeHtml(markdown: string): string {
  let out = ""
  let last = 0
  for (const span of markdown.matchAll(LITERALIZED_SPANS)) {
    const text = span[0]
    out += markdown.slice(last, span.index)
    out += span.groups?.tag === undefined ? text : text.replace(/</g, "&lt;").replace(/>/g, "&gt;")
    last = span.index + text.length
  }
  return out + markdown.slice(last)
}

function decodeMarkdown(input: string | Uint8Array) {
  if (typeof input === "string") {
    return {
      status: "decoded" as const,
      markdown: input,
      bytes: new TextEncoder().encode(input).byteLength,
    }
  }
  try {
    return {
      status: "decoded" as const,
      markdown: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input),
      bytes: input.byteLength,
    }
  } catch {
    return {
      status: "rejected" as const,
      reason: {
        code: "document_not_text" as const,
        message: "The document is not valid UTF-8 text.",
      },
      bytes: input.byteLength,
    }
  }
}

export function serializeMarkdownDocument(document: JSONContent, envelope: MarkdownEnvelope): MarkdownSerialization {
  try {
    const serialized = manager.serialize(document)
    return {
      status: "serialized",
      markdown: joinMarkdownEnvelope(envelope, normalizeSerializedMarkdownBody(envelope, serialized)),
    }
  } catch {
    return {
      status: "source",
      markdown: joinMarkdownEnvelope(envelope, envelope.body),
      reason: {
        code: "parser_failed",
        message: "The rich Markdown serializer could not safely process this document.",
      },
    }
  }
}
