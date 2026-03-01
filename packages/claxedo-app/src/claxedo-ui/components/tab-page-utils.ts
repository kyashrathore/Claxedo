/**
 * Pure utility functions extracted from tab-page.tsx
 *
 * Overlay state machine, diff algorithm, and node builders for the
 * Notion-style page editor. All functions are pure — no DOM, no signals.
 */

// ── Types ─────────────────────────────────────────────────────────────

type AiPanelPos = { x: number; y: number; width: number }
type AiSelection = { from: number; to: number }
type AiDraft = {
  text: string
  selection: AiSelection | null
  original: string
  range: AiSelection | null
  inline: boolean
}

export type OverlayState =
  | { type: "hidden" }
  | { type: "toolbar"; pos: { x: number; y: number } }
  | { type: "ai_menu"; pos: { x: number; y: number } }
  | { type: "ai_preview"; pos: AiPanelPos; draft: AiDraft }

export type OverlayEvent =
  | { type: "SELECTION"; pos: { x: number; y: number } | null }
  | { type: "TOGGLE_AI_MENU" }
  | { type: "AI_RESULT"; pos: AiPanelPos; draft: AiDraft }
  | { type: "HIDE_ALL" }
  | { type: "DISMISS_PREVIEW" }
  | { type: "CLEAR_PREVIEW" }

export type DiffPart = { kind: "equal" | "delete" | "insert"; text: string }
export type InlineMark = { type: string; attrs?: Record<string, string> }
export type InlineNode = { type: "text"; text: string; marks?: InlineMark[] } | { type: "hardBreak" }
export type BlockNode = { type: "paragraph"; content?: InlineNode[] }

// ── Constants ─────────────────────────────────────────────────────────

export const DIFF_DELETE_MARKS: InlineMark[] = [{ type: "strike" }, { type: "textStyle", attrs: { color: "#7c828f" } }]
export const DIFF_INSERT_MARKS: InlineMark[] = [{ type: "textStyle", attrs: { color: "#16a34a" } }]

// ── Overlay state machine ─────────────────────────────────────────────

export const reduceOverlay = (state: OverlayState, event: OverlayEvent): OverlayState => {
  if (event.type === "HIDE_ALL") {
    if (state.type === "ai_preview") return state
    return { type: "hidden" }
  }
  if (event.type === "DISMISS_PREVIEW") {
    if (state.type === "ai_preview") return { type: "hidden" }
    return state
  }
  if (event.type === "CLEAR_PREVIEW") {
    if (state.type === "ai_preview") return { type: "hidden" }
    return state
  }
  if (event.type === "AI_RESULT") return { type: "ai_preview", pos: event.pos, draft: event.draft }
  if (event.type === "TOGGLE_AI_MENU") {
    if (state.type === "toolbar") return { type: "ai_menu", pos: state.pos }
    if (state.type === "ai_menu") return { type: "toolbar", pos: state.pos }
    return state
  }
  if (!event.pos) {
    if (state.type === "ai_preview") return state
    return { type: "hidden" }
  }
  if (state.type === "ai_preview") return state
  if (state.type === "ai_menu") return { type: "ai_menu", pos: event.pos }
  return { type: "toolbar", pos: event.pos }
}

// ── Diff algorithm ────────────────────────────────────────────────────

export const tokenizeWordDiff = (text: string) => text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || []
export const tokenizeCharDiff = (text: string) => Array.from(text)

export const pushDiff = (list: DiffPart[], kind: DiffPart["kind"], text: string) => {
  if (!text) return
  const last = list[list.length - 1]
  if (last && last.kind === kind) {
    last.text += text
    return
  }
  list.push({ kind, text })
}

export const buildParts = (a: string[], b: string[]) => {
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
        continue
      }
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffPart[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushDiff(out, "equal", a[i])
      i += 1
      j += 1
      continue
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushDiff(out, "delete", a[i])
      i += 1
      continue
    }
    pushDiff(out, "insert", b[j])
    j += 1
  }
  while (i < a.length) {
    pushDiff(out, "delete", a[i])
    i += 1
  }
  while (j < b.length) {
    pushDiff(out, "insert", b[j])
    j += 1
  }
  return out
}

export const equalChars = (parts: DiffPart[]) =>
  parts.reduce((sum, part) => (part.kind === "equal" ? sum + part.text.length : sum), 0)

export const buildDiff = (oldText: string, newText: string): DiffPart[] => {
  if (oldText === newText) return [{ kind: "equal", text: oldText }]

  const word = buildParts(tokenizeWordDiff(oldText), tokenizeWordDiff(newText))
  const max = Math.max(oldText.length, newText.length, 1)
  const wordScore = equalChars(word) / max
  if (wordScore >= 0.35 || max > 700) return word

  const char = buildParts(tokenizeCharDiff(oldText), tokenizeCharDiff(newText))
  const charScore = equalChars(char) / max
  if (charScore > wordScore) return char
  return word
}

// ── Node builders ─────────────────────────────────────────────────────

export const pushTextNodes = (nodes: InlineNode[], text: string, marks?: InlineMark[]) => {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]) nodes.push(marks ? { type: "text", text: lines[i], marks } : { type: "text", text: lines[i] })
    if (i < lines.length - 1) nodes.push({ type: "hardBreak" })
  }
}

export const diffNodes = (oldText: string, newText: string) => {
  const nodes: InlineNode[] = []
  const parts = buildDiff(oldText, newText)
  for (const part of parts) {
    if (part.kind === "equal") {
      pushTextNodes(nodes, part.text)
      continue
    }
    if (part.kind === "delete") {
      pushTextNodes(nodes, part.text, DIFF_DELETE_MARKS)
      continue
    }
    pushTextNodes(nodes, part.text, DIFF_INSERT_MARKS)
  }
  return nodes
}

export const plainNodes = (text: string) => {
  const nodes: InlineNode[] = []
  pushTextNodes(nodes, text)
  return nodes
}

export const blockNodes = (text: string) =>
  text.split(/\n{2,}/).map((chunk) => {
    const content = plainNodes(chunk)
    if (!content.length) return { type: "paragraph" } as BlockNode
    return { type: "paragraph", content } as BlockNode
  })

export const nodeSize = (nodes: InlineNode[]) =>
  nodes.reduce((sum, node) => {
    if (node.type === "hardBreak") return sum + 1
    return sum + node.text.length
  }, 0)

// ── Helpers extracted from tab-page.tsx ──────────────────────────────

export const normalizeInstruction = (value: string | undefined) => {
  const text = value?.trim()
  return text ? text : ""
}

/** Lightweight editor shape so tests can pass a mock without importing @tiptap/core */
interface EditorLike {
  state: {
    doc: {
      forEach: (cb: (node: { nodeSize: number }, pos: number) => void) => void
      nodeAt: (pos: number) => unknown
    }
  }
}

export const getTopLevelAt = (editor: EditorLike, pos: number) => {
  const list: Array<{ pos: number; nodeSize: number; node: unknown }> = []
  editor.state.doc.forEach((node: { nodeSize: number }, at: number) => {
    list.push({ pos: at, nodeSize: node.nodeSize, node })
  })
  const index = list.findIndex((item) => pos >= item.pos && pos < item.pos + item.nodeSize)
  if (index < 0) return null
  return { list, index }
}

// ── Toolbar / menu types & data ──────────────────────────────────────

/** Minimal editor shape used by toolbar and menu item callbacks */
export interface ToolbarEditor {
  isActive: (...args: any[]) => boolean
  chain: () => any
}

export type ToolbarItem =
  | { kind: "divider"; key: string }
  | {
      kind: "action"
      key: string
      label: string
      icon: string
      style?: string
      active: (editor: ToolbarEditor) => boolean
      run: (editor: ToolbarEditor) => void
    }

export const TOOLBAR_ITEMS: ToolbarItem[] = [
  {
    kind: "action",
    key: "bold",
    label: "Bold",
    icon: "B",
    style: "font-weight:700",
    active: (editor) => editor.isActive("bold"),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    kind: "action",
    key: "underline",
    label: "Underline",
    icon: "U",
    style: "text-decoration:underline",
    active: (editor) => editor.isActive("underline"),
    run: (editor) => editor.chain().focus().toggleUnderline().run(),
  },
  {
    kind: "action",
    key: "italic",
    label: "Italic",
    icon: "I",
    style: "font-style:italic",
    active: (editor) => editor.isActive("italic"),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    kind: "action",
    key: "strike",
    label: "Strikethrough",
    icon: "S",
    style: "text-decoration:line-through",
    active: (editor) => editor.isActive("strike"),
    run: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    kind: "action",
    key: "code",
    label: "Inline Code",
    icon: "<>",
    style: "font-family:monospace;font-size:12px",
    active: (editor) => editor.isActive("code"),
    run: (editor) => editor.chain().focus().toggleCode().run(),
  },
  {
    kind: "action",
    key: "link",
    label: "Link",
    icon: "🔗",
    active: (editor) => editor.isActive("link"),
    run: () => {},
  },
  {
    kind: "action",
    key: "highlight-yellow",
    label: "Highlight",
    icon: "🖍",
    active: (editor) => editor.isActive("highlight"),
    run: (editor) => editor.chain().focus().toggleHighlight({ color: "#facc15" }).run(),
  },
  {
    kind: "action",
    key: "color-red",
    label: "Red text",
    icon: "A",
    style: "color:#ef4444",
    active: (editor) => editor.isActive("textStyle", { color: "#ef4444" }),
    run: (editor) => editor.chain().focus().setColor("#ef4444").run(),
  },
  {
    kind: "action",
    key: "color-reset",
    label: "Reset text color",
    icon: "A̶",
    active: () => false,
    run: (editor) => editor.chain().focus().unsetColor().run(),
  },
  { kind: "divider", key: "divider-1" },
  {
    kind: "action",
    key: "text",
    label: "Text",
    icon: "T",
    active: (editor) => editor.isActive("paragraph"),
    run: (editor) => editor.chain().focus().setParagraph().run(),
  },
  {
    kind: "action",
    key: "heading-1",
    label: "Heading 1",
    icon: "H1",
    active: (editor) => editor.isActive("heading", { level: 1 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    kind: "action",
    key: "heading-2",
    label: "Heading 2",
    icon: "H2",
    active: (editor) => editor.isActive("heading", { level: 2 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    kind: "action",
    key: "heading-3",
    label: "Heading 3",
    icon: "H3",
    active: (editor) => editor.isActive("heading", { level: 3 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  { kind: "divider", key: "divider-2" },
  {
    kind: "action",
    key: "align-left",
    label: "Align left",
    icon: "≡",
    active: (editor) => editor.isActive({ textAlign: "left" }),
    run: (editor) => editor.chain().focus().setTextAlign("left").run(),
  },
  {
    kind: "action",
    key: "align-center",
    label: "Align center",
    icon: "≣",
    active: (editor) => editor.isActive({ textAlign: "center" }),
    run: (editor) => editor.chain().focus().setTextAlign("center").run(),
  },
  {
    kind: "action",
    key: "align-right",
    label: "Align right",
    icon: "☰",
    active: (editor) => editor.isActive({ textAlign: "right" }),
    run: (editor) => editor.chain().focus().setTextAlign("right").run(),
  },
  { kind: "divider", key: "divider-2a" },
  {
    kind: "action",
    key: "bullet-list",
    label: "Bullet List",
    icon: "•",
    active: (editor) => editor.isActive("bulletList"),
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    kind: "action",
    key: "ordered-list",
    label: "Numbered List",
    icon: "1.",
    active: (editor) => editor.isActive("orderedList"),
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    kind: "action",
    key: "todo-list",
    label: "To-do",
    icon: "[]",
    active: (editor) => editor.isActive("taskList"),
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    kind: "action",
    key: "quote",
    label: "Quote",
    icon: "\"",
    active: (editor) => editor.isActive("blockquote"),
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    kind: "action",
    key: "code-block",
    label: "Code Block",
    icon: "{ }",
    active: (editor) => editor.isActive("codeBlock"),
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    kind: "action",
    key: "subscript",
    label: "Subscript",
    icon: "x₂",
    active: (editor) => editor.isActive("subscript"),
    run: (editor) => editor.chain().focus().toggleSubscript().run(),
  },
  {
    kind: "action",
    key: "superscript",
    label: "Superscript",
    icon: "x²",
    active: (editor) => editor.isActive("superscript"),
    run: (editor) => editor.chain().focus().toggleSuperscript().run(),
  },
  {
    kind: "action",
    key: "clear-formatting",
    label: "Clear formatting",
    icon: "Tx",
    active: () => false,
    run: (editor) => editor.chain().focus().unsetAllMarks().clearNodes().run(),
  },
]

export const FLOATING_TOOLBAR_KEYS = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "highlight-yellow",
  "clear-formatting",
])

export const FLOATING_TOOLBAR_ITEMS = TOOLBAR_ITEMS.filter(
  (item): item is Extract<ToolbarItem, { kind: "action" }> => item.kind === "action" && FLOATING_TOOLBAR_KEYS.has(item.key),
)

export type ConvertMenuItem = {
  key: string
  label: string
  active: (editor: ToolbarEditor) => boolean
  run: (editor: ToolbarEditor) => void
}

export const CONVERT_MENU_ITEMS: ConvertMenuItem[] = [
  {
    key: "convert-text",
    label: "Text",
    active: (editor) => editor.isActive("paragraph"),
    run: (editor) => editor.chain().focus().clearNodes().run(),
  },
  {
    key: "convert-h1",
    label: "Heading 1",
    active: (editor) => editor.isActive("heading", { level: 1 }),
    run: (editor) => editor.chain().focus().clearNodes().setHeading({ level: 1 }).run(),
  },
  {
    key: "convert-h2",
    label: "Heading 2",
    active: (editor) => editor.isActive("heading", { level: 2 }),
    run: (editor) => editor.chain().focus().clearNodes().setHeading({ level: 2 }).run(),
  },
  {
    key: "convert-h3",
    label: "Heading 3",
    active: (editor) => editor.isActive("heading", { level: 3 }),
    run: (editor) => editor.chain().focus().clearNodes().setHeading({ level: 3 }).run(),
  },
  {
    key: "convert-bullet",
    label: "Bulleted list",
    active: (editor) => editor.isActive("bulletList"),
    run: (editor) => {
      if (editor.isActive("bulletList")) return
      editor.chain().focus().clearNodes().toggleBulletList().run()
    },
  },
  {
    key: "convert-numbered",
    label: "Numbered list",
    active: (editor) => editor.isActive("orderedList"),
    run: (editor) => {
      if (editor.isActive("orderedList")) return
      editor.chain().focus().clearNodes().toggleOrderedList().run()
    },
  },
  {
    key: "convert-todo",
    label: "To-do list",
    active: (editor) => editor.isActive("taskList"),
    run: (editor) => {
      if (editor.isActive("taskList")) return
      editor.chain().focus().clearNodes().toggleTaskList().run()
    },
  },
  {
    key: "convert-quote",
    label: "Quote",
    active: (editor) => editor.isActive("blockquote"),
    run: (editor) => {
      if (editor.isActive("blockquote")) return
      editor.chain().focus().toggleBlockquote().run()
    },
  },
  {
    key: "convert-code-block",
    label: "Code block",
    active: (editor) => editor.isActive("codeBlock"),
    run: (editor) => {
      if (editor.isActive("codeBlock")) return
      editor.chain().focus().toggleCodeBlock().run()
    },
  },
]

export type AiMenuItem = {
  key: string
  label: string
  action: "improve" | "fix" | "shorten" | "lengthen" | "summarize" | "continue" | "custom"
  selectionRequired?: boolean
}

export const AI_MENU_ITEMS: AiMenuItem[] = [
  { key: "improve", label: "Improve writing", action: "improve", selectionRequired: true },
  { key: "fix", label: "Fix grammar", action: "fix", selectionRequired: true },
  { key: "shorten", label: "Make shorter", action: "shorten", selectionRequired: true },
  { key: "lengthen", label: "Make longer", action: "lengthen", selectionRequired: true },
  { key: "summarize", label: "Summarize", action: "summarize" },
  { key: "continue", label: "Continue writing", action: "continue" },
]

// ── AI selection helpers ───────────────────────────────────────────────

export type Selection = { from: number; to: number }

export const clampSelection = (selection: Selection | null, max: number): Selection | null => {
  if (!selection || max < 1) return null
  const from = Math.max(1, Math.min(selection.from, max))
  const to = Math.max(from, Math.min(selection.to, max))
  return { from, to }
}

export const pickAiSelection = (live: Selection | null, cached: Selection | null, max: number) => {
  const current = clampSelection(live, max)
  if (current) return current
  return clampSelection(cached, max)
}

export const canRunAiMenuItem = (item: AiMenuItem, hasLiveSelection: boolean, hasCachedSelection: boolean) => {
  if (!item.selectionRequired) return true
  return hasLiveSelection || hasCachedSelection
}

export const actionNeedsSelection = (action: AiMenuItem["action"]) => {
  if (action === "continue") return false
  if (action === "summarize") return false
  if (action === "custom") return false
  return true
}

// ── Popover anchoring ──────────────────────────────────────────────────

type AnchorPoint = { x: number; y: number }
type PopoverLayoutInput = {
  anchor: AnchorPoint | null
  width: number
  estimate: number
  viewport_height: number
  bounds_left: number
  bounds_right: number
  margin?: number
}

export const calcAnchoredPopover = (input: PopoverLayoutInput): AiPanelPos | null => {
  if (!input.anchor) return null
  const margin = input.margin ?? 10
  const x = Math.max(input.bounds_left, Math.min(input.anchor.x, input.bounds_right - input.width))
  const below = input.anchor.y + 12
  const above = input.anchor.y - input.estimate - 10
  const y = below + input.estimate > input.viewport_height - margin ? Math.max(margin, above) : below
  return { x, y, width: input.width }
}

// ── Scoped select-all ─────────────────────────────────────────────────

interface SelectAllEvent {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
}

interface SelectAllState {
  doc: {
    content: { size: number }
    forEach: (cb: (node: { nodeSize: number }, pos: number) => void) => void
  }
  selection: { from: number; to: number }
}

export const handleScopedSelectAll = (event: SelectAllEvent, state: SelectAllState): { from: number; to: number } | null => {
  const mod = event.metaKey || event.ctrlKey
  if (!mod || event.altKey || event.shiftKey) return null
  if (event.key.toLowerCase() !== "a") return null
  const max = state.doc.content.size
  if (max < 1) return null
  const at = Math.max(1, Math.min(state.selection.from, max))
  const list: Array<{ pos: number; nodeSize: number }> = []
  state.doc.forEach((node, pos) => {
    list.push({ pos, nodeSize: node.nodeSize })
  })
  const idx = list.findIndex((item) => at >= item.pos && at < item.pos + item.nodeSize)
  if (idx < 0) return { from: 1, to: max }
  const current = list[idx]
  const from = Math.max(1, Math.min(current.pos + 1, max))
  const to = Math.max(from, Math.min(current.pos + current.nodeSize - 1, max))
  const docSelected = state.selection.from <= 1 && state.selection.to >= max
  const blockSelected = state.selection.from <= from && state.selection.to >= to
  if (docSelected || blockSelected) return { from: 1, to: max }
  return { from, to }
}
