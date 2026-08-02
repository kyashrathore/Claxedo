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

  test("requestTerminalFitOnPaneChange dispatches immediately, then again after the delay", async () => {
    let received = 0
    const listener = () => {
      received += 1
    }
    window.addEventListener(FIT_EVENT, listener)

    try {
      requestTerminalFitOnPaneChange({ delay: 5 })
      expect(received).toBe(1)

      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(received).toBe(2)
    } finally {
      window.removeEventListener(FIT_EVENT, listener)
    }
  })
})
