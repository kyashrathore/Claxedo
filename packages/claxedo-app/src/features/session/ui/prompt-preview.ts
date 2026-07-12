// Pure rendering of the composer's live prompt parts into the short preview
// string that gets stashed via `setSessionHandoff`. Historically this exact
// map/join/trim lived byte-for-byte in both `session.tsx` and
// `session-composer-region.tsx` (two independent writers to the same handoff
// key). It now has one owner.

export type PromptPreviewPart =
  | { type: "file"; path?: string }
  | { type: "agent"; name?: string }
  | { type: "image"; filename?: string }
  | { type: string; content?: string }

/**
 * Collapse prompt parts into a single preview line:
 * - file parts render as `[file:<path>]`
 * - agent mentions render as `@<name>`
 * - image parts render as `[image:<filename>]`
 * - everything else contributes its text `content`
 *
 * The joined result is trimmed.
 */
export function previewPromptText(parts: readonly PromptPreviewPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "file") return `[file:${(part as { path?: string }).path}]`
      if (part.type === "agent") return `@${(part as { name?: string }).name}`
      if (part.type === "image") return `[image:${(part as { filename?: string }).filename}]`
      return (part as { content?: string }).content ?? ""
    })
    .join("")
    .trim()
}
