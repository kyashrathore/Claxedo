import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import type { Editor, Range } from "@tiptap/core"
import { slashCommandItems, SlashCommands, type SlashCommandEditor, type SlashCommandSuggestionOptions } from "./slash-commands"

// Replicate the extension's filter logic inline
function filterItems(query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return slashCommandItems
  return slashCommandItems.filter((item) =>
    `${item.title} ${item.description} ${item.search}`.toLowerCase().includes(q),
  )
}

describe("slashCommandItems data integrity", () => {
  test("all items have required fields (id, group, title, description, icon, search, command)", () => {
    for (const item of slashCommandItems) {
      expect(typeof item.id).toBe("string")
      expect(item.id.length).toBeGreaterThan(0)
      expect(typeof item.group).toBe("string")
      expect(item.group.length).toBeGreaterThan(0)
      expect(typeof item.title).toBe("string")
      expect(item.title.length).toBeGreaterThan(0)
      expect(typeof item.description).toBe("string")
      expect(item.description.length).toBeGreaterThan(0)
      expect(typeof item.icon).toBe("string")
      expect(item.icon.length).toBeGreaterThan(0)
      expect(typeof item.search).toBe("string")
      expect(item.search.length).toBeGreaterThan(0)
      expect(typeof item.command).toBe("function")
    }
  })

  test("no duplicate ids", () => {
    const ids = slashCommandItems.map((item) => item.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  test("every command is a function", () => {
    for (const item of slashCommandItems) {
      expect(typeof item.command).toBe("function")
    }
  })

  test("all groups are from known set", () => {
    const knownGroups = new Set(["AI", "Basic blocks", "Lists", "Advanced blocks", "Inline styles"])
    for (const item of slashCommandItems) {
      expect(knownGroups.has(item.group)).toBe(true)
    }
  })

  test("has at least one item per known group", () => {
    const knownGroups = new Set(["AI", "Basic blocks", "Lists", "Advanced blocks", "Inline styles"])
    const groupsWithItems = new Set(slashCommandItems.map((item) => item.group))
    for (const group of knownGroups) {
      expect(groupsWithItems.has(group)).toBe(true)
    }
  })
})

describe("slash command filtering", () => {
  test("empty query returns all items", () => {
    const results = filterItems("")
    expect(results.length).toBe(slashCommandItems.length)
    expect(results).toBe(slashCommandItems)
  })

  test('query "heading" matches Heading 1, 2, 3', () => {
    const results = filterItems("heading")
    expect(results.length).toBe(3)
    const ids = results.map((item) => item.id)
    expect(ids).toContain("h1")
    expect(ids).toContain("h2")
    expect(ids).toContain("h3")
  })

  test('query "list" matches items containing "list" in title/description/search', () => {
    const results = filterItems("list")
    expect(results.length).toBe(3)
    const ids = results.map((item) => item.id)
    expect(ids).toContain("bullet_list")
    expect(ids).toContain("ordered_list")
    expect(ids).toContain("todo")
  })

  test('query "ai" matches Ask AI plus text via "plain" in its description', () => {
    const results = filterItems("ai")
    expect(results.length).toBe(3)
    const ids = results.map((item) => item.id)
    expect(ids).toContain("ai_open")
    expect(ids).toContain("text")
    expect(ids).toContain("mermaid")
  })

  test('query "zzzzz" returns empty array', () => {
    const results = filterItems("zzzzz")
    expect(results.length).toBe(0)
  })
})

// ── Mock editor factory ───────────────────────────────────────────────

function mockEditor() {
  const calls: string[] = []
  const chain = new Proxy(
    {},
    {
      get(_, method: string) {
        return (..._args: unknown[]) => {
          calls.push(method)
          return chain
        }
      },
    },
  ) as ReturnType<Editor["chain"]>
  const editor: SlashCommandEditor = {
    chain: () => {
      calls.push("chain")
      return chain
    },
    getAttributes: (_type: string) => ({}),
    isActive: () => false,
  }
  return { editor, calls }
}

const range: Range = { from: 0, to: 1 }

function suggestionOptions() {
  return SlashCommands.configure({}).options.suggestion as SlashCommandSuggestionOptions
}

function findItem(id: string) {
  const item = slashCommandItems.find((i) => i.id === id)
  if (!item) throw new Error(`slash command item "${id}" not found`)
  return item
}

// ── Command callback tests ────────────────────────────────────────────

describe("slash command callbacks", () => {
  test('"ai_open" dispatches claxedo-page-ai-open event', () => {
    const events: CustomEvent[] = []
    const handler = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener("claxedo-page-ai-open", handler)
    try {
      const { editor, calls } = mockEditor()
      findItem("ai_open").command({ editor, range })
      expect(calls).toContain("deleteRange")
      expect(events).toHaveLength(1)
    } finally {
      window.removeEventListener("claxedo-page-ai-open", handler)
    }
  })

  test('"text" command calls setParagraph', () => {
    const { editor, calls } = mockEditor()
    findItem("text").command({ editor, range })
    expect(calls).toContain("chain")
    expect(calls).toContain("focus")
    expect(calls).toContain("deleteRange")
    expect(calls).toContain("setParagraph")
    expect(calls).toContain("run")
  })

  test('"h1" command calls setNode', () => {
    const { editor, calls } = mockEditor()
    findItem("h1").command({ editor, range })
    expect(calls).toContain("setNode")
    expect(calls).toContain("run")
  })

  test('"h2" command calls setNode', () => {
    const { editor, calls } = mockEditor()
    findItem("h2").command({ editor, range })
    expect(calls).toContain("setNode")
    expect(calls).toContain("run")
  })

  test('"h3" command calls setNode', () => {
    const { editor, calls } = mockEditor()
    findItem("h3").command({ editor, range })
    expect(calls).toContain("setNode")
    expect(calls).toContain("run")
  })

  test('"bullet_list" calls toggleBulletList', () => {
    const { editor, calls } = mockEditor()
    findItem("bullet_list").command({ editor, range })
    expect(calls).toContain("toggleBulletList")
    expect(calls).toContain("run")
  })

  test('"ordered_list" calls toggleOrderedList', () => {
    const { editor, calls } = mockEditor()
    findItem("ordered_list").command({ editor, range })
    expect(calls).toContain("toggleOrderedList")
    expect(calls).toContain("run")
  })

  test('"todo" calls toggleTaskList', () => {
    const { editor, calls } = mockEditor()
    findItem("todo").command({ editor, range })
    expect(calls).toContain("toggleTaskList")
    expect(calls).toContain("run")
  })

  test('"quote" calls toggleBlockquote', () => {
    const { editor, calls } = mockEditor()
    findItem("quote").command({ editor, range })
    expect(calls).toContain("toggleBlockquote")
    expect(calls).toContain("run")
  })

  test('"code_block" calls toggleCodeBlock', () => {
    const { editor, calls } = mockEditor()
    findItem("code_block").command({ editor, range })
    expect(calls).toContain("toggleCodeBlock")
    expect(calls).toContain("run")
  })

  test('"divider" calls setHorizontalRule', () => {
    const { editor, calls } = mockEditor()
    findItem("divider").command({ editor, range })
    expect(calls).toContain("setHorizontalRule")
    expect(calls).toContain("run")
  })

  test('"bold" calls toggleBold', () => {
    const { editor, calls } = mockEditor()
    findItem("bold").command({ editor, range })
    expect(calls).toContain("toggleBold")
    expect(calls).toContain("run")
  })

  test('"clear" calls unsetAllMarks and clearNodes', () => {
    const { editor, calls } = mockEditor()
    findItem("clear").command({ editor, range })
    expect(calls).toContain("unsetAllMarks")
    expect(calls).toContain("clearNodes")
    expect(calls).toContain("run")
  })


  test('"table" calls insertTable', () => {
    const { editor, calls } = mockEditor()
    findItem("table").command({ editor, range })
    expect(calls).toContain("insertTable")
    expect(calls).toContain("run")
  })

  test('"table_add_row_below" calls addRowAfter when inside table', () => {
    const { editor, calls } = mockEditor()
    editor.isActive = () => true
    findItem("table_add_row_below").command({ editor, range })
    expect(calls).toContain("addRowAfter")
    expect(calls).toContain("run")
  })

  test('"table_delete_row" calls deleteRow when inside table', () => {
    const { editor, calls } = mockEditor()
    editor.isActive = () => true
    findItem("table_delete_row").command({ editor, range })
    expect(calls).toContain("deleteRow")
    expect(calls).toContain("run")
  })

  test('"table_add_column_right" calls addColumnAfter when inside table', () => {
    const { editor, calls } = mockEditor()
    editor.isActive = () => true
    findItem("table_add_column_right").command({ editor, range })
    expect(calls).toContain("addColumnAfter")
    expect(calls).toContain("run")
  })

  test('"table_delete_column" calls deleteColumn when inside table', () => {
    const { editor, calls } = mockEditor()
    editor.isActive = () => true
    findItem("table_delete_column").command({ editor, range })
    expect(calls).toContain("deleteColumn")
    expect(calls).toContain("run")
  })

  test('"table_delete" calls deleteTable when inside table', () => {
    const { editor, calls } = mockEditor()
    editor.isActive = () => true
    findItem("table_delete").command({ editor, range })
    expect(calls).toContain("deleteTable")
    expect(calls).toContain("run")
  })

  test('"underline" calls toggleUnderline', () => {
    const { editor, calls } = mockEditor()
    findItem("underline").command({ editor, range })
    expect(calls).toContain("toggleUnderline")
    expect(calls).toContain("run")
  })

  test('"italic" calls toggleItalic', () => {
    const { editor, calls } = mockEditor()
    findItem("italic").command({ editor, range })
    expect(calls).toContain("toggleItalic")
    expect(calls).toContain("run")
  })

  test('"strike" calls toggleStrike', () => {
    const { editor, calls } = mockEditor()
    findItem("strike").command({ editor, range })
    expect(calls).toContain("toggleStrike")
    expect(calls).toContain("run")
  })

  test('"inline_code" calls toggleCode', () => {
    const { editor, calls } = mockEditor()
    findItem("inline_code").command({ editor, range })
    expect(calls).toContain("toggleCode")
    expect(calls).toContain("run")
  })

  test('"highlight" calls toggleHighlight', () => {
    const { editor, calls } = mockEditor()
    findItem("highlight").command({ editor, range })
    expect(calls).toContain("toggleHighlight")
    expect(calls).toContain("run")
  })

})

// ── Prompt-based command callbacks ─────────────────────────────────────

describe("prompt-based command callbacks", () => {
  let origPrompt: typeof window.prompt

  beforeEach(() => {
    origPrompt = window.prompt
  })

  afterEach(() => {
    window.prompt = origPrompt
  })

  test('"image" calls setImage with prompted URL', () => {
    window.prompt = () => "https://example.com/img.png"
    const { editor, calls } = mockEditor()
    findItem("image").command({ editor, range })
    expect(calls).toContain("setImage")
    expect(calls).toContain("run")
  })

  test('"image" does nothing when prompt returns null', () => {
    window.prompt = () => null
    const { editor, calls } = mockEditor()
    findItem("image").command({ editor, range })
    // Only the chain().focus().deleteRange(range) should NOT happen either
    // since promptUrl returns null before any editor chain call
    expect(calls).not.toContain("setImage")
  })

  test('"link" calls setLink with prompted URL', () => {
    window.prompt = () => "https://example.com"
    const { editor, calls } = mockEditor()
    findItem("link").command({ editor, range })
    expect(calls).toContain("setLink")
    expect(calls).toContain("run")
  })

  test('"link" calls unsetLink when URL is empty', () => {
    window.prompt = () => ""
    const { editor, calls } = mockEditor()
    findItem("link").command({ editor, range })
    expect(calls).toContain("unsetLink")
    expect(calls).toContain("run")
  })
})

// ── SlashCommands Tiptap extension ────────────────────────────────────

describe("SlashCommands extension filter config", () => {
  test("extension has name 'slashCommands'", () => {
    expect(SlashCommands.name).toBe("slashCommands")
  })

  test("suggestion char is '/'", () => {
    const options = suggestionOptions()
    expect(options.char).toBe("/")
  })

  test("suggestion items filter returns all items for empty query", () => {
    const items = suggestionOptions().items
    const all = items({ query: "" })
    expect(all.length).toBe(slashCommandItems.length)
  })

  test("suggestion items filter returns headings for 'heading' query", () => {
    const items = suggestionOptions().items
    const headings = items({ query: "heading" })
    expect(headings.length).toBe(3)
    const ids = headings.map((i) => i.id)
    expect(ids).toContain("h1")
    expect(ids).toContain("h2")
    expect(ids).toContain("h3")
  })

  test("allow callback returns true when text before slash is empty/whitespace", () => {
    const allow = suggestionOptions().allow
    const mockState = {
      doc: {
        resolve: (pos: number) => ({
          parent: { textBetween: () => "" },
          parentOffset: pos,
        }),
      },
    }
    expect(allow({ state: mockState, range: { from: 0, to: 1 } })).toBe(true)
  })

  test("allow callback returns false when text before slash is non-empty", () => {
    const allow = suggestionOptions().allow
    const mockState = {
      doc: {
        resolve: (pos: number) => ({
          parent: { textBetween: () => "some text" },
          parentOffset: pos,
        }),
      },
    }
    expect(allow({ state: mockState, range: { from: 5, to: 6 } })).toBe(false)
  })

  test("command callback delegates to item.command", () => {
    const command = suggestionOptions().command
    const { editor, calls } = mockEditor()
    const item = findItem("text")
    command({ editor, range, props: { item } })
    expect(calls).toContain("setParagraph")
    expect(calls).toContain("run")
  })
})
