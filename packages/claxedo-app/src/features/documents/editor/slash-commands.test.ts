import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Editor, Range } from "@tiptap/core"
import {
  filterSlashCommands,
  slashCommandItems,
  SlashCommands,
  type SlashCommandEditor,
  type SlashCommandSuggestionOptions,
} from "./slash-commands"

const filterItems = (query: string) => filterSlashCommands(slashCommandItems, query)

function findItem(id: string) {
  const item = slashCommandItems.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`slash command item "${id}" not found`)
  return item
}

describe("slash menu items", () => {
  test("items have unique IDs and nonempty menu labels", () => {
    expect(slashCommandItems.length).toBeGreaterThan(0)
    expect(new Set(slashCommandItems.map((item) => item.id)).size).toBe(slashCommandItems.length)
    for (const item of slashCommandItems) {
      for (const value of [item.id, item.group, item.title, item.description, item.icon, item.search]) {
        expect(value.trim().length, item.id).toBeGreaterThan(0)
      }
    }
  })

  test.each(["", " \t"])("empty query %j returns all items unchanged", (query) => {
    expect(filterItems(query)).toBe(slashCommandItems)
  })

  test("search matches headings regardless of case or surrounding whitespace", () => {
    expect(filterItems(" HEADING ").map((item) => item.id)).toEqual(["h1", "h2", "h3"])
  })

  test("search covers list names and task aliases", () => {
    expect(filterItems("list").map((item) => item.id)).toEqual(["bullet_list", "ordered_list", "todo"])
    expect(filterItems("checkbox").map((item) => item.id)).toEqual(["todo"])
    expect(filterItems("zzzzz")).toEqual([])
  })
})

type CommandCall = [name: string, ...args: unknown[]]

function recordEditor(input: { inTable?: boolean; href?: string } = {}) {
  const calls: CommandCall[] = []
  const chain = new Proxy({}, {
    get(_, method: string) {
      return (...args: unknown[]) => {
        calls.push([method, ...args])
        return chain
      }
    },
  }) as ReturnType<Editor["chain"]>
  const editor: SlashCommandEditor = {
    chain: () => {
      calls.push(["chain"])
      return chain
    },
    getAttributes: (type) => {
      expect(type).toBe("link")
      return { href: input.href }
    },
    isActive: (type) => {
      expect(type).toBe("table")
      return input.inTable === true
    },
  }
  return { editor, calls }
}

const range: Range = { from: 12, to: 19 }
const prefix: CommandCall[] = [["chain"], ["focus"], ["deleteRange", range]]

// The editor is the external command boundary: arguments and order protect the
// selected heading level, slash deletion, table shape, and inserted content.
const commands: Array<[id: string, expected: CommandCall[]]> = [
  ["text", [["setParagraph"]]],
  ["h1", [["setNode", "heading", { level: 1 }]]],
  ["h2", [["setNode", "heading", { level: 2 }]]],
  ["h3", [["setNode", "heading", { level: 3 }]]],
  ["bullet_list", [["toggleBulletList"]]],
  ["ordered_list", [["toggleOrderedList"]]],
  ["todo", [["toggleTaskList"]]],
  ["quote", [["toggleBlockquote"]]],
  ["code_block", [["toggleCodeBlock"]]],
  ["mermaid", [["setCodeBlock", { language: "mermaid" }], ["insertContent", "graph TD\n    A[Start] --> B[End]"]]],
  ["divider", [["setHorizontalRule"]]],
  ["table", [["insertTable", { rows: 3, cols: 3, withHeaderRow: true }]]],
  ["bold", [["toggleBold"]]],
  ["underline", [["toggleUnderline"]]],
  ["italic", [["toggleItalic"]]],
  ["strike", [["toggleStrike"]]],
  ["inline_code", [["toggleCode"]]],
  ["clear", [["unsetAllMarks"], ["clearNodes"]]],
]
const tableCommands = [
  ["table_add_row_below", "addRowAfter"],
  ["table_delete_row", "deleteRow"],
  ["table_add_column_right", "addColumnAfter"],
  ["table_delete_column", "deleteColumn"],
  ["table_delete", "deleteTable"],
] as const

describe("slash command callbacks", () => {
  test.each(commands)("%s applies the selected command after deleting the slash range", (id, expected) => {
    const { editor, calls } = recordEditor()
    findItem(id).command({ editor, range })
    expect(calls).toEqual([...prefix, ...expected, ["run"]])
  })

  test.each(tableCommands)("%s applies only inside a table", (id, command) => {
    for (const inTable of [false, true]) {
      const { editor, calls } = recordEditor({ inTable })
      findItem(id).command({ editor, range })
      expect(calls).toEqual([...prefix, ...(inTable ? [[command]] : []), ["run"]])
    }
  })
})

describe("prompted slash commands", () => {
  let originalPrompt: typeof window.prompt
  beforeEach(() => { originalPrompt = window.prompt })
  afterEach(() => { window.prompt = originalPrompt })

  test("image forwards the trimmed URL", () => {
    window.prompt = () => "  https://example.com/image.png  "
    const { editor, calls } = recordEditor()
    findItem("image").command({ editor, range })
    expect(calls).toEqual([...prefix, ["setImage", { src: "https://example.com/image.png" }], ["run"]])
  })

  test.each([null, "", " \t"])("image prompt %j leaves the document untouched", (answer) => {
    window.prompt = () => answer
    const { editor, calls } = recordEditor()
    findItem("image").command({ editor, range })
    expect(calls).toEqual([])
  })

  test("link prepopulates the current href and applies its trimmed replacement", () => {
    const prompts: unknown[][] = []
    window.prompt = (...args) => {
      prompts.push(args)
      return " https://new.example "
    }
    const { editor, calls } = recordEditor({ href: "https://old.example" })
    findItem("link").command({ editor, range })
    expect(prompts).toEqual([["Enter URL", "https://old.example"]])
    expect(calls).toEqual([...prefix, ["setLink", { href: "https://new.example" }], ["run"]])
  })

  test("canceling the link prompt leaves the document untouched", () => {
    window.prompt = () => null
    const { editor, calls } = recordEditor()
    findItem("link").command({ editor, range })
    expect(calls).toEqual([])
  })

  test("an empty link removes the existing mark", () => {
    window.prompt = () => " \t"
    const { editor, calls } = recordEditor()
    findItem("link").command({ editor, range })
    expect(calls).toEqual([...prefix, ["unsetLink"], ["run"]])
  })
})

function suggestionOptions() {
  return SlashCommands.configure({}).options.suggestion as SlashCommandSuggestionOptions
}

describe("slash suggestion wiring", () => {
  test("uses slash and the menu's search results", () => {
    const options = suggestionOptions()
    expect(options.char).toBe("/")
    expect(options.items({ query: "" })).toBe(slashCommandItems)
    expect(options.items({ query: "heading" }).map((item) => item.id)).toEqual(["h1", "h2", "h3"])
  })

  test.each([["", true], [" \t", true], ["some text", false]] as const)("text before slash %j permits suggestion: %s", (before, allowed) => {
    const state = {
      doc: {
        resolve: (position: number) => {
          expect(position).toBe(range.from)
          return { parent: { textBetween: () => before }, parentOffset: before.length }
        },
      },
    }
    expect(suggestionOptions().allow({ state, range })).toBe(allowed)
  })

  test("selection delegates the editor and range to the selected command", () => {
    const { editor, calls } = recordEditor()
    suggestionOptions().command({ editor, range, props: { item: findItem("h2") } })
    expect(calls).toEqual([...prefix, ["setNode", "heading", { level: 2 }], ["run"]])
  })
})
