/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { createFocusReturn, ownsEscape } from "./dialog-focus"

function control(connected: boolean) {
  const focused: unknown[] = []
  return { isConnected: connected, focus: (options?: FocusOptions) => void focused.push(options), focused }
}

describe("createFocusReturn", () => {
  test("returns focus once to the control that held it when the dialog opened", () => {
    const focus = createFocusReturn()
    const button = control(true)
    focus.remember(button)
    expect([focus.restore(), focus.restore()]).toEqual([true, false])
    expect(button.focused).toEqual([{ preventScroll: true }])
  })

  test("leaves focus alone when that control is gone or nothing could take focus", () => {
    const focus = createFocusReturn()
    const removed = control(false)
    focus.remember(removed)
    expect(focus.restore()).toBe(false)
    focus.remember(null)
    expect([focus.restore(), removed.focused]).toEqual([false, []])
  })
})

describe("ownsEscape", () => {
  test("keeps Escape for an element inside one that owns it", () => {
    expect(ownsEscape({ closest: (selector: string) => (selector === "[data-owns-escape]" ? {} : null) })).toBe(true)
    expect([ownsEscape({ closest: () => null }), ownsEscape(null), ownsEscape(notAnElement())]).toEqual([false, false, false])
  })
})

function notAnElement(): unknown {
  return { addEventListener: () => undefined }
}
