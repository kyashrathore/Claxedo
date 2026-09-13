import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"

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
 * code and a `#` is a comment. The parse is the editor's own markdown manager,
 * so paste, typing and loading all agree.
 */
export function markdownFromPaste(input: { html: string; text: string; inCode: boolean }): string | undefined {
  if (input.inCode) return undefined
  if (input.html.trim().length > 0) return undefined
  const text = input.text
  if (text.trim().length === 0) return undefined
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
            event.preventDefault()
            return editor.commands.insertContent(parsed)
          },
        },
      }),
    ]
  },
})
