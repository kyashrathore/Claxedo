import type { AnyExtension } from "@tiptap/core"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { Placeholder } from "@tiptap/extensions"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"

export function markdownExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ]
}

export function editorExtensions(placeholder: string): AnyExtension[] {
  return [...markdownExtensions(), Placeholder.configure({ placeholder }), Markdown]
}
