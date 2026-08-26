import { afterEach, describe, expect, test } from "bun:test"
import { stageMarkdownCollections } from "../../../../../session-ui/src/components/markdown-progressive"

const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout
  document.body.replaceChildren()
})

describe("progressive Markdown collections", () => {
  test("restores every staged row when a virtual row detaches before its delay", () => {
    let delayed: (() => void) | undefined
    globalThis.setTimeout = ((callback: TimerHandler) => {
      delayed = callback as () => void
      return 1 as never
    }) as typeof setTimeout
    const root = document.createElement("div")
    const list = document.createElement("ul")
    for (let index = 0; index < 40; index++) list.append(document.createElement("li"))
    root.append(list)
    document.body.append(root)

    stageMarkdownCollections(root)
    expect(list.children).toHaveLength(8)
    root.remove()
    delayed?.()

    expect(list.children).toHaveLength(40)
    expect(root.dataset.markdownProgressive).toBe("complete")
  })
})
