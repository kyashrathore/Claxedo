import { afterEach, describe, expect, test } from "bun:test"
import { composerFocus, focusComposerSurface, focusComposerWhenReady } from "./composer-focus"

function mountEditor(attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement("div")
  node.setAttribute("data-component", "prompt-input")
  node.setAttribute("role", "textbox")
  node.setAttribute("contenteditable", "true")
  node.tabIndex = 0
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  document.body.appendChild(node)
  return node
}

const realSchedule = composerFocus.schedule
afterEach(() => {
  document.body.innerHTML = ""
  composerFocus.schedule = realSchedule
})

describe("focusComposerSurface", () => {
  test("focuses the visible composer editor and reports success", () => {
    const editor = mountEditor()

    expect(focusComposerSurface()).toBe(true)
    expect(document.activeElement).toBe(editor)
  })

  test("returns false when no composer editor is mounted", () => {
    expect(focusComposerSurface()).toBe(false)
  })

  test("skips an aria-hidden editor and focuses the live one", () => {
    mountEditor({ "aria-hidden": "true" })
    const live = mountEditor()

    expect(focusComposerSurface()).toBe(true)
    expect(document.activeElement).toBe(live)
  })

  test("skips a disabled (contenteditable=false) editor", () => {
    mountEditor({ contenteditable: "false" })

    expect(focusComposerSurface()).toBe(false)
  })
})

describe("focusComposerWhenReady", () => {
  test("focuses a composer that mounts a few frames after the call", () => {
    // Drive the retry loop deterministically instead of real rAF.
    const queue: Array<() => void> = []
    composerFocus.schedule = (run) => queue.push(run)
    const flush = () => {
      const run = queue.shift()
      run?.()
    }

    let fallbackCalls = 0
    focusComposerWhenReady({ fallback: () => (fallbackCalls += 1) })

    // First two frames: composer not mounted yet.
    flush()
    flush()
    expect(document.activeElement).toBe(document.body)

    // Composer appears, next frame focuses it.
    const editor = mountEditor()
    flush()

    expect(document.activeElement).toBe(editor)
    expect(fallbackCalls).toBe(0)
  })

  test("runs the fallback when the composer never mounts", () => {
    composerFocus.schedule = (run) => run() // synchronous exhaustion

    let fallbackCalls = 0
    focusComposerWhenReady({ attempts: 3, fallback: () => (fallbackCalls += 1) })

    expect(fallbackCalls).toBe(1)
  })

  test("leaves focus alone when the user has moved it to some other real target", () => {
    const other = document.createElement("button")
    document.body.appendChild(other)
    other.focus()
    mountEditor()
    composerFocus.schedule = (run) => run()

    focusComposerWhenReady({ attempts: 3 })

    expect(document.activeElement).toBe(other)
  })

  test("hands off from the control that triggered it instead of reading it as user-moved focus", () => {
    // A click-triggered handoff starts with focus on the clicked control, which
    // the plain bail-out cannot tell apart from "the user moved focus here".
    const origin = document.createElement("button")
    origin.setAttribute("data-slot", "navigation-row-activate")
    document.body.appendChild(origin)
    origin.focus()
    const editor = mountEditor()
    composerFocus.schedule = (run) => run()

    focusComposerWhenReady({ from: origin, attempts: 3 })

    expect(document.activeElement).toBe(editor)
  })

  test("still refuses to steal focus from a third element while waiting on a declared origin", () => {
    const origin = document.createElement("button")
    const elsewhere = document.createElement("button")
    document.body.append(origin, elsewhere)
    elsewhere.focus()
    mountEditor()
    composerFocus.schedule = (run) => run()

    focusComposerWhenReady({ from: origin, attempts: 3 })

    expect(document.activeElement).toBe(elsewhere)
  })
})
