import { Editor, type EditorOptions } from "@tiptap/core"
import { createEffect, createSignal, type Accessor } from "solid-js"

type TiptapEditorOptions<T extends HTMLElement> = Omit<Partial<EditorOptions>, "element"> & { element: T }

/** Solid 2-compatible owner for a Tiptap editor instance. */
export function createTiptapEditor<T extends HTMLElement>(
  options: () => TiptapEditorOptions<T> | undefined,
): Accessor<Editor | undefined> {
  const [editor, setEditor] = createSignal<Editor>()
  const applyEditorOptions = (next: TiptapEditorOptions<T> | undefined) => {
    if (!next) {
      setEditor()
      return
    }
    const instance = new Editor(next)
    setEditor(() => instance)
    return () => instance.destroy()
  }
  createEffect(options, applyEditorOptions)
  return editor
}
