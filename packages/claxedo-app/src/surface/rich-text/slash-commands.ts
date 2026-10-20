import type { Editor, Range } from "@tiptap/core"

export type BlockCommandId = "text" | "heading1" | "heading2" | "heading3" | "bulletList" | "numberedList" | "todoList" | "quote" | "codeBlock" | "divider"

export type BlockCommand = {
  readonly id: BlockCommandId
  readonly keywords: readonly string[]
  readonly run: (editor: Editor, range: Range) => void
}

function blockAt(editor: Editor, range: Range) {
  return editor.chain().focus().deleteRange(range)
}

export const BLOCK_COMMANDS: readonly BlockCommand[] = [
  { id: "text", keywords: ["text", "paragraph", "plain"], run: (editor, range) => blockAt(editor, range).setParagraph().run() },
  { id: "heading1", keywords: ["heading", "h1", "title"], run: (editor, range) => blockAt(editor, range).setHeading({ level: 1 }).run() },
  { id: "heading2", keywords: ["heading", "h2", "subtitle"], run: (editor, range) => blockAt(editor, range).setHeading({ level: 2 }).run() },
  { id: "heading3", keywords: ["heading", "h3"], run: (editor, range) => blockAt(editor, range).setHeading({ level: 3 }).run() },
  { id: "bulletList", keywords: ["bullet", "list", "unordered"], run: (editor, range) => blockAt(editor, range).toggleBulletList().run() },
  { id: "numberedList", keywords: ["numbered", "ordered", "list"], run: (editor, range) => blockAt(editor, range).toggleOrderedList().run() },
  { id: "todoList", keywords: ["todo", "task", "checkbox", "list"], run: (editor, range) => blockAt(editor, range).toggleTaskList().run() },
  { id: "quote", keywords: ["quote", "blockquote"], run: (editor, range) => blockAt(editor, range).toggleBlockquote().run() },
  { id: "codeBlock", keywords: ["code", "block", "snippet"], run: (editor, range) => blockAt(editor, range).toggleCodeBlock().run() },
  { id: "divider", keywords: ["divider", "rule", "separator", "hr"], run: (editor, range) => blockAt(editor, range).setHorizontalRule().run() },
]

export function matchingBlockCommands(query: string, label: (id: BlockCommandId) => string): readonly BlockCommand[] {
  const typed = query.trim().toLowerCase()
  if (typed === "") return BLOCK_COMMANDS
  return BLOCK_COMMANDS.filter((command) => label(command.id).toLowerCase().includes(typed) || command.keywords.some((keyword) => keyword.startsWith(typed)))
}
