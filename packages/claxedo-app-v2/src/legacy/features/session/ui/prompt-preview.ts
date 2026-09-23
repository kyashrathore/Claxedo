// Pure rendering of the composer's live prompt parts into the short preview
// string that gets stashed via `setSessionHandoff`. Historically this exact
// map/join/trim lived byte-for-byte in both `session.tsx` and
// `session-composer-region.tsx` (two independent writers to the same handoff
// key). It now has one owner.

/**
 * The fields a prompt part can contribute to the preview line.
 *
 * Deliberately one record rather than a union discriminated on `type`: the
 * fallback arm has to accept ANY part kind, and a `{ type: string }` arm in a
 * union swallows the literal arms, so `part.type === "file"` narrowed nothing
 * and each branch had to assert its own shape back. Reading the field the branch
 * wants off one optional-field record says the same thing with no assertion.
 */
export type PromptPreviewPart = {
  type: string
  path?: string
  name?: string
  filename?: string
  content?: string
}

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
      if (part.type === "file") return `[file:${part.path}]`
      if (part.type === "agent") return `@${part.name}`
      if (part.type === "image") return `[image:${part.filename}]`
      return part.content ?? ""
    })
    .join("")
    .trim()
}
