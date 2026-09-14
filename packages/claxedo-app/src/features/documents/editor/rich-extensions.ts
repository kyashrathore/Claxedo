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
import { OrderedListParenInput, markdownLinkInputRule } from "./markdown-input-rules"
import { MarkdownPaste } from "./markdown-paste"
import { SlashCommands } from "./slash-commands"

/** The single production extension list used by both the editor and its fidelity proof. */
export function documentRichEditorExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ codeBlock: false, link: false, underline: false }),
    OrderedListParenInput,
    MermaidCodeBlock,
    // Upstream ships no input rule for a link, so the syntax stayed literal
    // while every other mark converted.
    Link.extend({
      addInputRules() {
        return [markdownLinkInputRule(this.type)]
      },
    }).configure({ openOnClick: false, autolink: true }),
    Underline,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    // Inline, because that is where the markdown parser puts an image. As a
    // block node the bundled input rule replaced the paragraph being typed and
    // `getMarkdown()` came back empty, so typing and loading disagreed.
    Image.configure({ allowBase64: true, inline: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    SlashCommands,
    Markdown,
    MarkdownPaste,
  ]
}
