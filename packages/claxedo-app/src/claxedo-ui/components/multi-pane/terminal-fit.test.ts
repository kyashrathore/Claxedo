import { describe, expect, test } from "bun:test"
import { emitTerminalFit, requestTerminalFitOnPaneChange, requestTerminalFitOnPaneFocus } from "./terminal-fit"

describe("emitTerminalFit", () => {
  test("dispatches opencode:terminal-fit", () => {
    const events: string[] = []
    const target = {
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    }

    emitTerminalFit(target as Window)
    expect(events).toEqual(["opencode:terminal-fit"])
  })
})

describe("requestTerminalFitOnPaneChange", () => {
  test("dispatches immediately and once after delay", () => {
    const events: string[] = []
    const timers: Array<() => void> = []
    const target = {
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
      setTimeout: (fn: () => void) => {
        timers.push(fn)
        return 1 as ReturnType<typeof setTimeout>
      },
    }

    requestTerminalFitOnPaneChange({ target: target as Window, delay: 42 })
    expect(events).toEqual(["opencode:terminal-fit"])
    expect(timers).toHaveLength(1)

    timers[0]()
    expect(events).toEqual(["opencode:terminal-fit", "opencode:terminal-fit"])
  })
})

describe("requestTerminalFitOnPaneFocus", () => {
  test("dispatches for terminal panes", () => {
    const events: string[] = []
    const target = {
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    }

    requestTerminalFitOnPaneFocus({ type: "terminal", target: target as Window })
    expect(events).toEqual(["opencode:terminal-fit"])
  })

  test("skips non-terminal panes", () => {
    const events: string[] = []
    const target = {
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
    }

    requestTerminalFitOnPaneFocus({ type: "session", target: target as Window })
    expect(events).toEqual([])
  })
})
