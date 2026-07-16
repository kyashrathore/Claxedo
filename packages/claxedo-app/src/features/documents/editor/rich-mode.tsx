import { Editor } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { TableKit } from "@tiptap/extension-table"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import StarterKit from "@tiptap/starter-kit"
import { onCleanup, onMount } from "solid-js"
import { serializeMarkdownDocument, type RichMarkdown } from "@/features/documents/markdown/detector"
import { MermaidCodeBlock } from "./mermaid-block"
import { SlashCommands } from "./slash-commands"

type SelectionAction = "improve" | "fix" | "shorten"

export function RichMode(props: {
  detection: RichMarkdown
  onInput: (markdown: string) => void
  onBlur: () => void
  onEditSource: () => void
  onSerializationError: (error: Error) => void
  onSelectionAction?: (action: SelectionAction, selected: string) => Promise<string>
}) {
  let element!: HTMLDivElement
  let editor: Editor | undefined
  onMount(() => {
    editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        MermaidCodeBlock,
        Image,
        TableKit,
        TaskList,
        TaskItem,
        SlashCommands,
      ],
      content: props.detection.document,
      editorProps: {
        attributes: {
          class: "min-h-[24rem] px-6 py-5 text-sm leading-7 text-text-strong outline-none",
          "aria-label": "Document rich editor",
        },
      },
      onUpdate: ({ editor }) => {
        const serialized = serializeMarkdownDocument(editor.getJSON(), props.detection.envelope)
        if (serialized.status === "serialized") props.onInput(serialized.markdown)
        if (serialized.status === "source") props.onSerializationError(new Error(serialized.reason.message))
      },
    })
    onCleanup(() => editor?.destroy())
  })

  const selectionAction = (action: SelectionAction) => {
    if (!editor || !props.onSelectionAction) return
    const range = editor.state.selection
    const selected = editor.state.doc.textBetween(range.from, range.to, "\n")
    if (!selected) return
    void props.onSelectionAction(action, selected).then((replacement) => {
      editor?.chain().focus().insertContentAt({ from: range.from, to: range.to }, replacement).run()
    }, props.onSerializationError)
  }

  return (
    <section class="min-h-0 flex-1 overflow-auto" aria-label="Rich Markdown editor" onFocusOut={props.onBlur}>
      <div
        class="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-border-weak-base bg-background-base px-6 py-2"
        role="toolbar"
        aria-label="Document formatting"
      >
        <button
          type="button"
          class="rounded px-2 py-1 text-xs hover:bg-surface-raised-base"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          Bold
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-xs hover:bg-surface-raised-base"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          Italic
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-xs hover:bg-surface-raised-base"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          Heading
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-xs hover:bg-surface-raised-base"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          List
        </button>
        <span class="mx-1 h-4 w-px bg-border-weak-base" aria-hidden="true" />
        <button
          type="button"
          class="rounded px-2 py-1 text-xs hover:bg-surface-raised-base"
          onClick={props.onEditSource}
        >
          Edit source
        </button>
        <span class="mx-1 h-4 w-px bg-border-weak-base" aria-hidden="true" />
        {(["improve", "fix", "shorten"] as const).map((action) => (
          <button
            type="button"
            class="rounded px-2 py-1 text-xs capitalize hover:bg-surface-raised-base disabled:cursor-not-allowed disabled:text-text-weak"
            disabled={!props.onSelectionAction}
            title={props.onSelectionAction ? `${action} selection` : "Selection actions require an agent connection"}
            onClick={() => selectionAction(action)}
          >
            {action}
          </button>
        ))}
      </div>
      <div ref={element} />
    </section>
  )
}
