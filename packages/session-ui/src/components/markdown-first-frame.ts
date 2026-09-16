import { Marked } from "marked"
import { transcriptMarkdownExtensions } from "@opencode-ai/ui/context/marked"
import { sanitizeMarkdown } from "./markdown-cache"

/**
 * The largest block the first frame parses on the main thread. marked's lexer
 * is quadratic in the source it scans: a single 32 KiB block costs ~80 ms and
 * a 1 MiB one 5–15 s, which held the renderer past CDP's 60 s timeout on the
 * benchmark's long-row transcripts. 8 KiB is ~9 ms worst case.
 */
export const FIRST_FRAME_RICH_MAX_CHARS = 8 * 1024

const syncParser = new Marked(...transcriptMarkdownExtensions)

/** Escaped source with line breaks: not markdown, but never wrong. */
export function escapedMarkdown(markdown: string) {
  return markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>")
}

/**
 * First-frame HTML for live tokens and cold remounts. A block over the budget
 * paints as escaped text and takes its markup from the asynchronous parse
 * that follows; a block within it is parsed here so the first frame is rich.
 */
export function firstFrameHtml(src: string) {
  if (src.length > FIRST_FRAME_RICH_MAX_CHARS) return escapedMarkdown(src)
  try {
    const parsed = syncParser.parse(src, { async: false })
    if (typeof parsed !== "string") return escapedMarkdown(src)
    return sanitizeMarkdown(parsed)
  } catch {
    return escapedMarkdown(src)
  }
}
