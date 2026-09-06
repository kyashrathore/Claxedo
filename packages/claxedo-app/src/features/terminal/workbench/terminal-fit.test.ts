import { describe, expect, test } from "bun:test"

import { FIT_EVENT, emitTerminalFit, requestTerminalFitOnPaneChange } from "./terminal-fit"

describe("terminal-fit", () => {
  test("FIT_EVENT is the single canonical event name, namespaced under claxedo:", () => {
    expect(FIT_EVENT).toBe("claxedo:terminal-fit")
  })

  test("emitTerminalFit dispatches FIT_EVENT and a window listener receives it", () => {
    let received = 0
    const listener = () => {
      received += 1
    }
    window.addEventListener(FIT_EVENT, listener)

    try {
      emitTerminalFit()
      expect(received).toBe(1)
    } finally {
      window.removeEventListener(FIT_EVENT, listener)
    }
  })

  test("requestTerminalFitOnPaneChange dispatches now and schedules the deferred fit", () => {
    const events: Event[] = []
    const scheduled: Array<{ run: () => void; delay: number | undefined }> = []
    const target = {
      dispatchEvent: (event: Event) => { events.push(event); return true },
      setTimeout: ((run: () => void, delay?: number) => {
        scheduled.push({ run, delay })
        return 1
      }) as Window["setTimeout"],
    }
    requestTerminalFitOnPaneChange({ delay: 5, target })
    expect(events.map((event) => event.type)).toEqual([FIT_EVENT])
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].delay).toBe(5)
    scheduled[0].run()
    expect(events.map((event) => event.type)).toEqual([FIT_EVENT, FIT_EVENT])
  })
})
