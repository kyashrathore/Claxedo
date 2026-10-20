import type * as TiptapEditor from "./tiptap-editor"

export type RichTextModule = typeof TiptapEditor

export type { RichTextEditorHandle } from "./tiptap-editor"

export function loadRichTextModule(): Promise<RichTextModule> {
  return import("./tiptap-editor")
}
