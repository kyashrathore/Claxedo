import { describe, expect, test } from "bun:test"
import { composerCollapsed } from "./collapsed-state"

const idle = {
  collapsible: true,
  editorFocused: false,
  blank: true,
  contextItemCount: 0,
  popoverOpen: false,
  documentPickerOpen: false,
}

describe("composerCollapsed", () => {
  test("an idle collapsible composer collapses", () => {
    expect(composerCollapsed(idle)).toBe(true)
  })

  test("a docked composer never collapses", () => {
    expect(composerCollapsed({ ...idle, collapsible: false })).toBe(false)
  })

  test.each([
    ["editor focus", { editorFocused: true }],
    ["a draft", { blank: false }],
    ["a context chip", { contextItemCount: 1 }],
    ["an open popover", { popoverOpen: true }],
    ["the document picker", { documentPickerOpen: true }],
  ] as const)("%s expands it", (_, override) => {
    expect(composerCollapsed({ ...idle, ...override })).toBe(false)
  })
})
