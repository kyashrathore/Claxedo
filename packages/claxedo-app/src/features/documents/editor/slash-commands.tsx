/**
 * Slash Commands — Tiptap extension + SolidJS popup menu
 *
 * Type "/" at the start of a line or after a space to open a command palette
 * with block type options (headings, lists, code block, etc.).
 */

import { Extension, type Editor, type Range } from "@tiptap/core"
import Suggestion, { type SuggestionOptions, type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion"
import { createSignal, createEffect, For, Show } from "solid-js"
import { render as solidRender } from "solid-js/web"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"

// ── Command items ──────────────────────────────────────────────────────

function promptUrl(initial?: string) {
  if (typeof window === "undefined") return null
  return window.prompt("Enter URL", initial || "https://")
}

export interface SlashCommandItem {
  id: string
  group: string
  title: string
  description: string
  icon: string
  shortcut?: string
  search: string
  command: (props: { editor: SlashCommandEditor; range: Range }) => void
}

export type SlashCommandEditor = Pick<Editor, "chain" | "getAttributes" | "isActive">

export type SlashCommandSuggestionOptions = Partial<SuggestionOptions<SlashCommandItem>> & {
  char: "/"
  allow: NonNullable<Partial<SuggestionOptions<SlashCommandItem>>["allow"]>
  items: (input: { query: string }) => SlashCommandItem[]
  command: (input: { editor: SlashCommandEditor; range: Range; props: { item: SlashCommandItem } }) => void
}

export const slashCommandItems: SlashCommandItem[] = [
  {
    id: "text",
    group: "Basic blocks",
    title: "Text",
    description: "Just start writing with plain text",
    icon: "T",
    search: "paragraph text normal body",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setParagraph().run()
    },
  },
  {
    id: "h1",
    group: "Basic blocks",
    title: "Heading 1",
    description: "Large section heading",
    icon: "H1",
    search: "heading title section h1",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run()
    },
  },
  {
    id: "h2",
    group: "Basic blocks",
    title: "Heading 2",
    description: "Medium section heading",
    icon: "H2",
    search: "heading subtitle section h2",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run()
    },
  },
  {
    id: "h3",
    group: "Basic blocks",
    title: "Heading 3",
    description: "Small section heading",
    icon: "H3",
    search: "heading small section h3",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run()
    },
  },
  {
    id: "bullet_list",
    group: "Lists",
    title: "Bullet List",
    description: "Unordered list",
    icon: "•",
    shortcut: "[]",
    search: "bulleted unordered list points",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run()
    },
  },
  {
    id: "ordered_list",
    group: "Lists",
    title: "Numbered List",
    description: "Ordered list",
    icon: "1.",
    shortcut: "1.",
    search: "numbered ordered list",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run()
    },
  },
  {
    id: "todo",
    group: "Lists",
    title: "To-do List",
    description: "Task list with checkboxes",
    icon: "☐",
    search: "todo task checklist checkbox",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run()
    },
  },
  {
    id: "quote",
    group: "Advanced blocks",
    title: "Quote",
    description: "Capture a quote or callout",
    icon: "❝",
    search: "blockquote quote callout",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run()
    },
  },
  {
    id: "code_block",
    group: "Advanced blocks",
    title: "Code Block",
    description: "Fenced code block",
    icon: "</>",
    search: "code snippet pre",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
    },
  },
  {
    id: "mermaid",
    group: "Advanced blocks",
    title: "Mermaid Diagram",
    description: "Flowchart, sequence diagram, etc.",
    icon: "◇",
    search: "mermaid diagram flowchart sequence graph chart",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range)
        .setCodeBlock({ language: "mermaid" })
        .insertContent("graph TD\n    A[Start] --> B[End]")
        .run()
    },
  },
  {
    id: "divider",
    group: "Advanced blocks",
    title: "Divider",
    description: "Insert a horizontal divider",
    icon: "---",
    search: "divider line horizontal rule hr",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run()
    },
  },
  {
    id: "table",
    group: "Advanced blocks",
    title: "Table",
    description: "Insert a 3 x 3 table",
    icon: "▦",
    search: "table grid rows columns",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    },
  },
  {
    id: "table_add_row_below",
    group: "Advanced blocks",
    title: "Table: Add row below",
    description: "Add a row below the current table row",
    icon: "↧",
    search: "table row below add",
    command: ({ editor, range }) => {
      const chain = editor.chain().focus().deleteRange(range)
      if (!editor.isActive("table")) return chain.run()
      chain.addRowAfter().run()
    },
  },
  {
    id: "table_delete_row",
    group: "Advanced blocks",
    title: "Table: Delete row",
    description: "Delete the current table row",
    icon: "⌦",
    search: "table row delete remove",
    command: ({ editor, range }) => {
      const chain = editor.chain().focus().deleteRange(range)
      if (!editor.isActive("table")) return chain.run()
      chain.deleteRow().run()
    },
  },
  {
    id: "table_add_column_right",
    group: "Advanced blocks",
    title: "Table: Add column right",
    description: "Add a column to the right",
    icon: "⇥",
    search: "table column right add",
    command: ({ editor, range }) => {
      const chain = editor.chain().focus().deleteRange(range)
      if (!editor.isActive("table")) return chain.run()
      chain.addColumnAfter().run()
    },
  },
  {
    id: "table_delete_column",
    group: "Advanced blocks",
    title: "Table: Delete column",
    description: "Delete the current table column",
    icon: "⌫",
    search: "table column delete remove",
    command: ({ editor, range }) => {
      const chain = editor.chain().focus().deleteRange(range)
      if (!editor.isActive("table")) return chain.run()
      chain.deleteColumn().run()
    },
  },
  {
    id: "table_delete",
    group: "Advanced blocks",
    title: "Table: Delete table",
    description: "Remove the current table",
    icon: "⨯",
    search: "table delete remove",
    command: ({ editor, range }) => {
      const chain = editor.chain().focus().deleteRange(range)
      if (!editor.isActive("table")) return chain.run()
      chain.deleteTable().run()
    },
  },
  {
    id: "image",
    group: "Advanced blocks",
    title: "Image from URL",
    description: "Embed an image by URL",
    icon: "🖼",
    search: "image media photo picture url",
    command: ({ editor, range }) => {
      const src = promptUrl()
      if (src === null) return
      const value = src.trim()
      if (!value) return
      editor.chain().focus().deleteRange(range).setImage({ src: value }).run()
    },
  },
  {
    id: "bold",
    group: "Inline styles",
    title: "Bold",
    description: "Toggle bold text",
    icon: "B",
    shortcut: "Cmd+B",
    search: "bold strong",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBold().run()
    },
  },
  {
    id: "underline",
    group: "Inline styles",
    title: "Underline",
    description: "Toggle underline",
    icon: "U",
    shortcut: "Cmd+U",
    search: "underline mark style",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleUnderline().run()
    },
  },
  {
    id: "italic",
    group: "Inline styles",
    title: "Italic",
    description: "Toggle italic text",
    icon: "I",
    shortcut: "Cmd+I",
    search: "italic emphasis",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleItalic().run()
    },
  },
  {
    id: "strike",
    group: "Inline styles",
    title: "Strikethrough",
    description: "Toggle strikethrough text",
    icon: "S",
    shortcut: "Cmd+Shift+S",
    search: "strike delete crossed",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleStrike().run()
    },
  },
  {
    id: "inline_code",
    group: "Inline styles",
    title: "Inline Code",
    description: "Toggle inline code",
    icon: "<>",
    shortcut: "Cmd+E",
    search: "inline code",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCode().run()
    },
  },
  {
    id: "link",
    group: "Inline styles",
    title: "Link",
    description: "Add or edit a link",
    icon: "🔗",
    shortcut: "Cmd+K",
    search: "link url href anchor",
    command: ({ editor, range }) => {
      const current = editor.getAttributes("link").href as string | undefined
      const href = promptUrl(current)
      if (href === null) return
      const value = href.trim()
      if (!value) {
        editor.chain().focus().deleteRange(range).unsetLink().run()
        return
      }
      editor.chain().focus().deleteRange(range).setLink({ href: value }).run()
    },
  },
  {
    id: "clear",
    group: "Inline styles",
    title: "Clear Formatting",
    description: "Remove marks and reset block type",
    icon: "Tx",
    search: "clear reset remove formatting",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).unsetAllMarks().clearNodes().run()
    },
  },
]

// ── SolidJS popup component ────────────────────────────────────────────

function SlashMenu(props: {
  items: () => SlashCommandItem[]
  selectedIndex: () => number
  onSelect: (item: SlashCommandItem) => void
  onHover: (index: number) => void
}) {
  let menuRef!: HTMLDivElement

  // Scroll active item into view when index changes
  createEffect(() => {
    const idx = props.selectedIndex()
    const el = menuRef?.querySelector(`[data-index="${idx}"]`)
    el?.scrollIntoView({ block: "nearest" })
  })

  return (
    <div
      ref={menuRef}
      class="slash-command-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      <Show
        when={props.items().length > 0}
        fallback={
          <div class="slash-command-empty">
            <span class="slash-command-empty-title">No matching blocks</span>
            <span class="slash-command-empty-description">Try a different keyword</span>
          </div>
        }
      >
        <For each={props.items()}>
          {(item, index) => (
            <>
              <Show when={index() === 0 || props.items()[index() - 1]?.group !== item.group}>
                <div class="slash-command-group">{item.group}</div>
              </Show>
              <button
                type="button"
                data-index={index()}
                class="slash-command-item"
                classList={{ "slash-command-item-active": index() === props.selectedIndex() }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  props.onSelect(item)
                }}
                onMouseEnter={() => props.onHover(index())}
              >
                <span class="slash-command-icon">{item.icon}</span>
                <div class="slash-command-text">
                  <span class="slash-command-title">{item.title}</span>
                  <span class="slash-command-description">{item.description}</span>
                </div>
                <Show when={item.shortcut}>
                  <span class="slash-command-shortcut">{item.shortcut}</span>
                </Show>
              </button>
            </>
          )}
        </For>
      </Show>
    </div>
  )
}

// ── Render bridge (SolidJS ↔ Tiptap suggestion plugin) ─────────────────

const MENU_HEIGHT_ESTIMATE = 360 // max-height + padding
const MENU_GAP = 6

function createSuggestionRenderer() {
  let popup: HTMLDivElement | null = null
  let dispose: (() => void) | null = null
  const run = (props: SuggestionProps<SlashCommandItem>, item: SlashCommandItem) =>
    (props.command as (input: { item: SlashCommandItem }) => void)({ item })

  // Reactive signals shared with the SolidJS component
  const [items, setItems] = createSignal<SlashCommandItem[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let commandFn: ((item: SlashCommandItem) => void) | null = null

  function show(props: SuggestionProps<SlashCommandItem>) {
    popup = document.createElement("div")
    popup.style.position = "fixed"
    popup.style.zIndex = "9999"
    document.body.appendChild(popup)

    setItems(props.items)
    setSelectedIndex(0)
    commandFn = (item) => run(props, item)

    updatePosition(props)

    dispose = solidRender(
      () => (
        <SlashMenu
          items={items}
          selectedIndex={selectedIndex}
          onSelect={(item) => commandFn?.(item)}
          onHover={(idx) => setSelectedIndex(idx)}
        />
      ),
      popup,
    )

    requestAnimationFrame(() => updatePosition(props))
  }

  function updatePosition(props: SuggestionProps<SlashCommandItem>) {
    if (!popup) return
    const rect = props.clientRect?.()
    if (!rect) return

    const menuEl = popup.querySelector(".slash-command-menu") as HTMLElement | null
    const menuH = menuEl?.offsetHeight ?? MENU_HEIGHT_ESTIMATE
    const menuW = menuEl?.offsetWidth ?? 280
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth
    const spaceBelow = viewportH - rect.bottom - MENU_GAP
    const spaceAbove = rect.top - MENU_GAP

    let top: number
    if (spaceBelow >= MENU_HEIGHT_ESTIMATE || spaceBelow >= spaceAbove) {
      // Place below
      top = rect.bottom + MENU_GAP
    } else {
      // Place above
      top = rect.top - menuH - MENU_GAP
    }

    // Clamp to viewport
    const maxTop = Math.max(MENU_GAP, viewportH - menuH - MENU_GAP)
    top = Math.max(MENU_GAP, Math.min(top, maxTop))
    const left = Math.max(MENU_GAP, Math.min(rect.left, viewportW - menuW - MENU_GAP))

    popup.style.left = `${left}px`
    popup.style.top = `${top}px`
  }

  function update(props: SuggestionProps<SlashCommandItem>) {
    if (!popup || !dispose) {
      show(props)
      return
    }

    // Update reactive signals — SolidJS re-renders automatically, no destroy/recreate
    setItems(props.items)
    setSelectedIndex((prev) => Math.max(0, Math.min(prev, Math.max(0, props.items.length - 1))))
    commandFn = (item) => run(props, item)
    updatePosition(props)
  }

  function destroy() {
    dispose?.()
    dispose = null
    popup?.remove()
    popup = null
    commandFn = null
  }

  function onKeyDown({ event }: SuggestionKeyDownProps): boolean {
    const len = items().length
    if (!len && event.key !== "Escape") return false

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % len)
      return true
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + len) % len)
      return true
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const idx = selectedIndex()
      const list = items()
      if (list[idx]) commandFn?.(list[idx])
      return true
    }
    if (event.key === "Tab") {
      destroy()
      return false
    }
    if (event.key === "Escape") {
      event.preventDefault()
      destroy()
      return true
    }
    return false
  }

  return {
    onStart: show,
    onUpdate: update,
    onExit: destroy,
    onKeyDown,
  }
}

// ── Tiptap extension ───────────────────────────────────────────────────

/**
 * The shipped slash-menu filter predicate. An empty/whitespace query returns
 * the full list unchanged (identity, so callers can `===`-compare); otherwise
 * items are matched case-insensitively against their title + description +
 * search text. Exported so the extension config and its tests exercise the
 * exact same predicate.
 */
export function filterSlashCommands(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => `${item.title} ${item.description} ${item.search}`.toLowerCase().includes(q))
}

export const SlashCommands = Extension.create({
  name: "slashCommands",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        allowSpaces: true,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $slash = state.doc.resolve(range.from)
          const textBeforeSlash = $slash.parent.textBetween(0, $slash.parentOffset, "\n", "\n")
          return textBeforeSlash.trim().length === 0
        },
        items: ({ query }: { query: string }) => filterSlashCommands(slashCommandItems, query),
        render: createSuggestionRenderer,
        command: ({ editor, range, props }: { editor: SlashCommandEditor; range: Range; props: { item: SlashCommandItem } }) => {
          phCapture("page_slash_command_used", { ...identityProps(), surface: "documents", command_id: props.item.id, command_title: props.item.title })
          props.item.command({ editor, range })
        },
      } satisfies SlashCommandSuggestionOptions,
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ]
  },
})
