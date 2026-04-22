/**
 * Claxedo-owned helper that produces the synthetic text-part body for a
 * page-element comment. Lives under the claxedo browser feature (not an
 * override of `@/utils/comment-note`) so upstream's file-comment formatting
 * is never touched.
 *
 * Shape matches `formatCommentNote` in spirit — a single human-readable line
 * the LLM can parse — but identifies the origin as a browser element and
 * includes the selector + page URL. When an `outerHTML` is present and under
 * the 1 KB cap, appends a fenced HTML block so the model can inspect the
 * element markup without additional tool calls.
 */

export type FormatElementCommentNoteInput = {
  selector: string
  pageUrl: string
  comment: string
  outerHTML?: string
}

const OUTER_HTML_MAX_BYTES = 1024

export function formatElementCommentNote(input: FormatElementCommentNoteInput): string {
  const comment = input.comment.trim()
  const base = `The user commented on element \`${input.selector}\` at ${input.pageUrl}: ${comment}`
  const outer = input.outerHTML?.trim()
  if (!outer) return base
  if (byteLength(outer) >= OUTER_HTML_MAX_BYTES) return base
  return `${base}\n\n\`\`\`html\n${outer}\n\`\`\``
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    try {
      return new TextEncoder().encode(value).length
    } catch {
      // fall through to char-count fallback
    }
  }
  // Rough fallback for environments without TextEncoder — UTF-16 code units.
  return value.length
}
