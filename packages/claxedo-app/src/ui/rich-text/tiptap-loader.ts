/**
 * Lazy Tiptap loader for the shared rich-text editor.
 *
 * Domain-neutral (no feature imports) so this editor can live in @/ui and be
 * shared across features. Kept intentionally lean — StarterKit + Link is all a
 * description/brief field needs, and a smaller schema keeps markdown
 * serialization simple. Loads on first use so Tiptap stays out of the initial
 * bundle.
 */

import type { createTiptapEditor } from "./tiptap-editor"

export type RichTextDeps = {
  createTiptapEditor: typeof createTiptapEditor
  StarterKit: typeof import("@tiptap/starter-kit").default
  Link: typeof import("@tiptap/extension-link").default
}

let pending: Promise<RichTextDeps> | undefined

export const loadRichText = () =>
  (pending ??= Promise.all([
    import("./tiptap-editor"),
    import("@tiptap/starter-kit"),
    import("@tiptap/extension-link"),
  ]).then(([tiptap, starter, link]) => ({
    createTiptapEditor: tiptap.createTiptapEditor,
    StarterKit: starter.default,
    Link: link.default,
  })))
