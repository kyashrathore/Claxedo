import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSubagentHeadingFocus } from "./review-workspace-subagent-tabs"

let frames: Array<(() => void) | undefined>
let realRequest: typeof requestAnimationFrame
let realCancel: typeof cancelAnimationFrame

function flush(count = 1) {
  for (let i = 0; i < count; i += 1) {
    const pending = frames
    frames = []
    for (const frame of pending) frame?.()
  }
}

beforeEach(() => {
  frames = []
  realRequest = globalThis.requestAnimationFrame
  realCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(() => callback(0))
    return frames.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    frames[id - 1] = undefined
  }) as typeof cancelAnimationFrame
})

afterEach(() => {
  globalThis.requestAnimationFrame = realRequest
  globalThis.cancelAnimationFrame = realCancel
})

function heading() {
  const focused: boolean[] = []
  const element = document.createElement("h1")
  element.focus = () => { focused.push(true) }
  return { focused, element }
}

describe("subagent heading focus", () => {
  test("waits for the lazily mounted transcript instead of giving up on the first frame", () => {
    const target = heading()
    let mounted = false
    const focus = createSubagentHeadingFocus({ find: () => (mounted ? target.element : null) })

    focus.request("ses_child")
    flush(3)
    expect(target.focused).toEqual([])

    mounted = true
    flush()
    expect(target.focused).toEqual([true])
  })

  test("stops asking once the budget runs out", () => {
    let asked = 0
    const focus = createSubagentHeadingFocus({ find: () => { asked += 1; return null }, frames: 3 })

    focus.request("ses_child")
    flush(10)

    expect(asked).toBe(3)
  })

  test("a second open cancels the first, so one heading wins the focus", () => {
    const first = heading()
    const second = heading()
    const focus = createSubagentHeadingFocus({
      find: (sessionId) => (sessionId === "ses_a" ? first.element : second.element),
    })

    focus.request("ses_a")
    focus.request("ses_b")
    flush(5)

    expect(first.focused).toEqual([])
    expect(second.focused).toEqual([true])
  })

  test("cancel drops a wait the workspace no longer owns", () => {
    const target = heading()
    const focus = createSubagentHeadingFocus({ find: () => target.element })

    focus.request("ses_child")
    focus.cancel()
    flush(5)

    expect(target.focused).toEqual([])
  })
})
