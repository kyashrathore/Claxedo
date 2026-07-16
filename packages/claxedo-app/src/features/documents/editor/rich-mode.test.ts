import { describe, expect, test } from "bun:test"
import { applySelectionTransform, selectionTransformTarget, type SelectionEditor } from "./rich-mode"

function editor() {
  let text = "Selected text"
  let document = { textBetween: () => text }
  let writes = 0
  let saves = 0
  const value = {
    state: { selection: { from: 1, to: 14 }, doc: document },
    chain: () => ({
      focus: () => ({
        insertContentAt: (_range: unknown, replacement: string) => ({
          run: () => {
            text = replacement
            document = { textBetween: () => text }
            value.state.doc = document
            writes++
            saves++
          },
        }),
      }),
    }),
  } satisfies SelectionEditor
  return {
    value,
    type(next: string) {
      text = next
      document = { textBetween: () => text }
      value.state.doc = document
    },
    counts: () => ({ writes, saves }),
  }
}

describe("rich selection transforms", () => {
  test("typing during an async transform preserves the user edit and causes no transform autosave", () => {
    const view = editor()
    const target = selectionTransformTarget(view.value)!
    view.type("Human edit")

    expect(applySelectionTransform(view.value, target, "Agent edit")).toBe(false)
    expect(view.counts()).toEqual({ writes: 0, saves: 0 })
  })

  test("double-click transforms apply only the newest result when responses arrive out of order", () => {
    const view = editor()
    const first = selectionTransformTarget(view.value)!
    const second = selectionTransformTarget(view.value)!

    expect(applySelectionTransform(view.value, second, "Newest result")).toBe(true)
    expect(applySelectionTransform(view.value, first, "Stale result")).toBe(false)
    expect(view.counts()).toEqual({ writes: 1, saves: 1 })
  })
})
