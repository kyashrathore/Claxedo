/**
 * Shared rich-text editor — a Tiptap surface initialized from and writing a
 * markdown string. Presentation-only and feature-neutral so any surface can
 * reuse it (stream descriptions, docs, …) without duplicating editor wiring.
 */
import { createResource, onCleanup, Show } from "solid-js"
import { docToMarkdown, markdownToJSON } from "./markdown"
import { loadRichText, type RichTextDeps } from "./tiptap-loader"
import "./rich-text-editor.css"

export type RichTextEditorProps = {
  value?: string
  onChange?: (markdown: string) => void
  placeholder?: string
  class?: string
  autofocus?: boolean
  ariaLabel?: string
}

export function RichTextEditor(props: RichTextEditorProps) {
  const [deps] = createResource(loadRichText)
  return (
    <div class={`richtext ${props.class ?? ""}`}>
      <Show when={deps()} fallback={<div class="richtext-surface richtext-loading" aria-hidden="true" />}>
        {(ready) => <Mounted deps={ready()} {...props} />}
      </Show>
    </div>
  )
}

function Mounted(props: RichTextEditorProps & { deps: RichTextDeps }) {
  let element!: HTMLDivElement
  let frame!: HTMLDivElement
  const showPlaceholder = (empty: boolean) => frame.classList.toggle("is-empty", empty)

  const editor = props.deps.createTiptapEditor(() => ({
    element,
    extensions: [props.deps.StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }), props.deps.Link.configure({ openOnClick: false })],
    autofocus: props.autofocus ? ("end" as const) : false,
    editorProps: { attributes: { class: "richtext-surface", role: "textbox", "aria-multiline": "true", "aria-label": props.ariaLabel ?? "" } },
    onCreate: ({ editor }) => {
      const value = props.value ?? ""
      if (value) editor.commands.setContent(markdownToJSON(editor.schema, value), { emitUpdate: false })
      showPlaceholder(editor.isEmpty)
    },
    onUpdate: ({ editor }) => {
      showPlaceholder(editor.isEmpty)
      const markdown = editor.isEmpty ? "" : docToMarkdown(editor.state.doc)
      props.onChange?.(markdown)
    },
  }))

  onCleanup(() => editor()?.destroy())

  return (
    <div ref={frame} class="richtext-frame is-empty">
      <Show when={props.placeholder}>
        <div class="richtext-placeholder" aria-hidden="true">
          {props.placeholder}
        </div>
      </Show>
      <div ref={element} />
    </div>
  )
}
