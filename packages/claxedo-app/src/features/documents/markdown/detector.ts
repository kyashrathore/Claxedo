import type { JSONContent } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { MarkdownManager } from "@tiptap/markdown"
import { TableKit } from "@tiptap/extension-table"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import StarterKit from "@tiptap/starter-kit"
import { joinMarkdownEnvelope, splitMarkdownEnvelope, type MarkdownEnvelope } from "./frontmatter"

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

export function detectMarkdown(input: string | Uint8Array): MarkdownDetection {
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
  const unsupported = unsupportedSyntax(envelope.body)
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
    if (serialized.markdown === markdown) {
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

function unsupportedSyntax(markdown: string) {
  const prose = markdown
    .replace(/^(?<fence>`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\k<fence>[ \t]*(?=\n|$)|$)/gm, "")
    .replace(/(`+)[^\n]*?\1/g, "")
  return [
    { name: "Reference links", pattern: /^\s{0,3}\[[^\]\n]+\]:\s*\S|\[[^\]\n]+\]\[[^\]\n]*\]/m },
    { name: "Setext headings", pattern: /^\S.*\n(?:=+|-+)[ \t]*$/m },
    { name: "HTML", pattern: /<!--[\s\S]*?-->|<\/?[A-Za-z][^>\n]*>/ },
    { name: "Footnotes", pattern: /\[\^[^\]\n]+\]/ },
    { name: "Math", pattern: /\$\$|(?<!\\)\$(?!\s)(?:[^$\n]|\\\$)+\$/ },
    { name: "Liquid templates", pattern: /\{[{%]-?[\s\S]*?-?[%}]\}/ },
    { name: "MDX modules", pattern: /^(?:import|export)\s/m },
    { name: "Brace expressions", pattern: /\{[\s\S]*?\}/ },
    { name: "Merge conflict markers", pattern: /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m },
  ].find((entry) => entry.pattern.test(prose))?.name
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
    const body =
      envelope.body.trim().length === 0 && serialized === ""
        ? envelope.body
        : serialized === ""
          ? ""
          : serialized.replace(/\n*$/, "") + (envelope.body.match(/\n*$/)?.[0] ?? "")
    return { status: "serialized", markdown: joinMarkdownEnvelope(envelope, body) }
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
