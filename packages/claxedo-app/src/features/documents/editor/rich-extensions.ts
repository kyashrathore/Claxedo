import type { AnyExtension } from "@tiptap/core"
import Color from "@tiptap/extension-color"
import Highlight from "@tiptap/extension-highlight"
import Image from "@tiptap/extension-image"
import Link from "@tiptap/extension-link"
import { Table } from "@tiptap/extension-table"
import TableCell from "@tiptap/extension-table-cell"
import TableHeader from "@tiptap/extension-table-header"
import TableRow from "@tiptap/extension-table-row"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import { TextStyle } from "@tiptap/extension-text-style"
import Underline from "@tiptap/extension-underline"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { MermaidCodeBlock } from "./mermaid-block"
import { SlashCommands } from "./slash-commands"

/** The single production extension list used by both the editor and its fidelity proof. */
export function documentRichEditorExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ codeBlock: false, link: false, underline: false }),
    MermaidCodeBlock,
    Link.configure({ openOnClick: false, autolink: true }),
    Underline,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Image.configure({ allowBase64: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    SlashCommands,
    Markdown,
  ]
}
