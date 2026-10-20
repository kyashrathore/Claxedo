/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { matchingBlockCommands, BLOCK_COMMANDS, type BlockCommandId } from "./slash-commands"
import { slashMenuPlacement } from "./slash-placement"

const LABELS: Record<BlockCommandId, string> = {
  text: "Text",
  heading1: "Heading 1",
  heading2: "Heading 2",
  heading3: "Heading 3",
  bulletList: "Bulleted list",
  numberedList: "Numbered list",
  todoList: "To-do list",
  quote: "Quote",
  codeBlock: "Code block",
  divider: "Divider",
}
const ids = (query: string) => matchingBlockCommands(query, (id) => LABELS[id]).map((command) => command.id)

describe("matchingBlockCommands", () => {
  test("offers every block for an empty query, in the menu's order", () => {
    expect(ids("")).toEqual(BLOCK_COMMANDS.map((command) => command.id))
  })

  test("matches the shown label anywhere and a keyword by its start", () => {
    expect(ids("head")).toEqual(["heading1", "heading2", "heading3"])
    expect(ids("todo")).toEqual(["todoList"])
    expect(ids("hr")).toEqual(["divider"])
    expect(ids("list")).toEqual(["bulletList", "numberedList", "todoList"])
    expect(ids("zebra")).toEqual([])
  })
})

describe("slashMenuPlacement", () => {
  test("opens under the caret, inside the editor's frame, while it fits above the viewport's bottom", () => {
    expect(slashMenuPlacement({ left: 140, top: 200, bottom: 220 }, { left: 100, top: 150 }, 900)).toEqual({ left: "40px", top: "74px" })
  })

  test("opens above the caret when the menu would run past the viewport", () => {
    expect(slashMenuPlacement({ left: 140, top: 700, bottom: 720 }, { left: 100, top: 150 }, 900)).toEqual({ left: "40px", top: "246px" })
  })
})
