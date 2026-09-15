import { describe, expect, test } from "bun:test"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { createRoot } from "solid-js"

// The @-mention popover race: `useFilteredList`'s active key lags the painted
// list — `initialActive` is captured while `flat()` is empty and `reset` runs in
// an effect after the async filter resolves. Enter landing in that window must
// still select, matching `initialActive`/`reset`'s first-item default.
const keydown = (key: string) => new KeyboardEvent("keydown", { key })

async function flush() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function run(
  options: { noInitialSelection?: boolean },
  setup: (list: ReturnType<typeof useFilteredList<string>>, selected: string[]) => void,
) {
  return new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const selected: string[] = []
      const list = useFilteredList<string>({
        items: ["a", "b"],
        key: (x) => x,
        noInitialSelection: options.noInitialSelection,
        onSelect: (item) => {
          if (item) selected.push(item)
        },
      })
      queueMicrotask(async () => {
        try {
          await flush()
          setup(list, selected)
          dispose()
          resolve()
        } catch (error) {
          dispose()
          reject(error)
        }
      })
    })
  })
}

describe("useFilteredList Enter", () => {
  test("selects the first item when the active key has not resolved", () =>
    run({}, (list, selected) => {
      list.setActive("")
      list.onKeyDown(keydown("Enter"))
      expect(selected).toEqual(["a"])
    }))

  test("selects the active item when one is set", () =>
    run({}, (list, selected) => {
      list.setActive("b")
      list.onKeyDown(keydown("Enter"))
      expect(selected).toEqual(["b"])
    }))

  test("does not invent a selection when the list opted out of one", () =>
    run({ noInitialSelection: true }, (list, selected) => {
      list.onKeyDown(keydown("Enter"))
      expect(selected).toEqual([])
    }))
})
