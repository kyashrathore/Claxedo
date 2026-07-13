/**
 * Lazy Tiptap loader for the shared rich-text editor.
 *
 * Domain-neutral (no feature imports) so this editor can live in @/ui and be
 * shared across features. Kept intentionally lean — StarterKit + Link is all a
 * description/brief field needs, and a smaller schema keeps markdown
 * serialization simple. Loads on first use so Tiptap stays out of the initial
 * bundle.
 */

export type RichTextDeps = {
  createTiptapEditor: typeof import("solid-tiptap").createTiptapEditor
  StarterKit: typeof import("@tiptap/starter-kit").default
  Link: typeof import("@tiptap/extension-link").default
}

let pending: Promise<RichTextDeps> | undefined

export const loadRichText = () =>
  (pending ??= Promise.all([import("solid-tiptap"), import("@tiptap/starter-kit"), import("@tiptap/extension-link")]).then(([solid, starter, link]) => ({
    createTiptapEditor: solid.createTiptapEditor,
    StarterKit: starter.default,
    Link: link.default,
  })))
