import { Editor } from "@tiptap/core"
import { MarkdownManager } from "@tiptap/markdown"
import { marked } from "marked"
import { editorExtensions, markdownExtensions } from "./extensions"
import { markdownRoundTrips } from "./markdown-fit"
import { slashExtension, type SlashMenuHost } from "./slash-extension"
import type { BlockCommandId } from "./slash-commands"

export type RichTextEditorOptions = {
  readonly element: HTMLElement
  readonly markdown: string
  readonly label: string
  readonly placeholder: string
  readonly slash: SlashMenuHost
  readonly commandLabel: (id: BlockCommandId) => string
  readonly onChange: (markdown: string) => void
  readonly onBlur: () => void
}

export type RichTextEditorHandle = {
  readonly setMarkdown: (markdown: string) => void
  readonly destroy: () => void
}

const MARKDOWN = new MarkdownManager({ extensions: markdownExtensions() })

function renderedHtml(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true })
}

export function markdownFits(markdown: string): boolean {
  return markdownRoundTrips(markdown, MARKDOWN, renderedHtml)
}

function editorMarkdown(editor: Editor): string {
  return editor.getMarkdown().replace(/\s+$/, "")
}

export function createRichTextEditor(options: RichTextEditorOptions): RichTextEditorHandle {
  const editor = new Editor({
    element: options.element,
    extensions: [...editorExtensions(options.placeholder), slashExtension(options.slash, options.commandLabel)],
    content: options.markdown,
    contentType: "markdown",
    editorProps: { attributes: { role: "textbox", "aria-multiline": "true", "aria-label": options.label, "data-slot": "surface-editor-content" } },
    onUpdate: ({ editor: current }) => options.onChange(editorMarkdown(current)),
    onBlur: () => options.onBlur(),
  })
  return {
    setMarkdown: (markdown) => editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false }),
    destroy: () => editor.destroy(),
  }
}
