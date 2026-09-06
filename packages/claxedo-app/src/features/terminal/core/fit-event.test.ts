import { describe, expect, test } from "bun:test"
import { dispatchTerminalFitEvent, onTerminalFitEvent } from "./fit-event"

describe("terminal fit event subscription", () => {
  test("receives canonical fit events until unsubscribed", () => {
    const target = new EventTarget()
    let fits = 0
    const unsubscribe = onTerminalFitEvent(target, () => { fits += 1 })
    try {
      target.dispatchEvent(new Event("unrelated"))
      expect(fits).toBe(0)
      dispatchTerminalFitEvent(target)
      expect(fits).toBe(1)
    } finally {
      unsubscribe()
    }
    dispatchTerminalFitEvent(target)
    expect(fits).toBe(1)
  })
})
