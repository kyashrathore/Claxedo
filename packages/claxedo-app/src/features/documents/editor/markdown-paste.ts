import { Extension } from "@tiptap/core"
import { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { detectMarkdown } from "@/features/documents/markdown/detector"
import { splitMarkdownEnvelope } from "@/features/documents/markdown/frontmatter"

/**
 * Plain text pasted into a markdown document is markdown.
 *
 * `@tiptap/markdown` 3.23.4 has no paste option of its own — its only settings
 * are `indentation`, `marked` and `markedOptions` — so without this a pasted
 * document arrives as one literal paragraph per line, headings and tables
 * included.
 *
 * Only when the clipboard carries no `text/html`: an editor or a browser that
 * supplies HTML has already described the structure, and re-reading its plain
 * text would throw that away. Never inside a code block, where the text is
 * code and a `#` is a comment. And only text this extension set can represent,
 * decided by the same detector that decides rich mode: markdown outside the
 * contract parses to content with no node to hold it — an HTML comment comes
 * back as `<"keep ", paragraph, " this">`, which no paragraph accepts — so
 * that text is left to ProseMirror's own paste, which inserts it literally.
 *
 * Text carrying frontmatter is a whole document rather than a fragment to drop
 * into one, and the detector only ever reads the body an envelope splits off:
 * admitting it here would gate one string and insert another, turning the
 * delimiters into a rule and the metadata into loose prose.
 */
export function markdownFromPaste(input: { html: string; text: string; inCode: boolean }): string | undefined {
  if (input.inCode) return undefined
  if (input.html.trim().length > 0) return undefined
  const text = input.text
  if (text.trim().length === 0) return undefined
  if (splitMarkdownEnvelope(text).frontmatter.length > 0) return undefined
  if (detectMarkdown(text, "normalizing").status !== "rich") return undefined
  return text
}

export const MarkdownPaste = Extension.create({
  name: "markdownPaste",

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey("markdownPaste"),
        props: {
          handlePaste: (view, event) => {
            const clipboard = event.clipboardData
            if (!clipboard) return false
            const markdown = markdownFromPaste({
              html: clipboard.getData("text/html"),
              text: clipboard.getData("text/plain"),
              inCode: view.state.selection.$from.parent.type.spec.code === true,
            })
            if (markdown === undefined) return false
            const parsed = editor.markdown?.parse(markdown)
            if (!parsed) return false
            const content = ProseMirrorNode.fromJSON(editor.schema, parsed).content
            // A lone paragraph is a phrase, and an open slice lets it join the
            // sentence holding the caret instead of splitting it in two.
            // Anything else is structure the author typed, and opening it makes
            // the heading, the quote and every list item after the first
            // dissolve into the paragraph they landed in; a closed slice splits
            // that paragraph around them and keeps them.
            const phrase = content.childCount === 1 && content.firstChild?.type === editor.schema.nodes.paragraph
            event.preventDefault()
            view.dispatch(
              view.state.tr.replaceSelection(phrase ? Slice.maxOpen(content) : new Slice(content, 0, 0)).scrollIntoView(),
            )
            return true
          },
        },
      }),
    ]
  },
})
