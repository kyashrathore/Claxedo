import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { setupPasteHandler } from "./clipboard"

const cleanups: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose()
  vi.clearAllTimers()
  vi.useRealTimers()
  document.body.replaceChildren()
})
function paste(textarea: HTMLTextAreaElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } })
  textarea.dispatchEvent(event)
  return event
}
function textarea() {
  const element = document.createElement("textarea")
  document.body.append(element)
  return element
}

describe("setupPasteHandler browser event boundary", () => {
  test.each([false, true])("handles text once and normalizes newlines (bracketed: %s)", (bracketed) => {
    const element = textarea()
    const nativePaste = vi.fn()
    const onWrite = vi.fn()
    // The xterm listener is registered first. Our capture handler must prevent
    // its normal bubbling handler from processing the same browser event.
    element.addEventListener("paste", nativePaste)
    cleanups.push(setupPasteHandler({ textarea: element, paste: vi.fn() }, {
      onWrite, isBracketedPasteEnabled: () => bracketed,
    }))
    const event = paste(element, "first\r\nsecond\nthird")
    expect(event.defaultPrevented).toBe(true)
    expect(nativePaste).not.toHaveBeenCalled()
    expect(onWrite.mock.calls).toEqual([[bracketed ? "\x1b[200~first\rsecond\rthird\x1b[201~" : "first\rsecond\rthird"]])
  })

  test("delegates exactly once to xterm when direct write is not supplied", () => {
    const element = textarea()
    const terminalPaste = vi.fn()
    cleanups.push(setupPasteHandler({ textarea: element, paste: terminalPaste }))
    paste(element, "hello")
    expect(terminalPaste.mock.calls).toEqual([["hello"]])
  })

  test("a new paste cancels unsent chunks from the previous paste", () => {
    const element = textarea()
    const onWrite = vi.fn()
    cleanups.push(setupPasteHandler({ textarea: element, paste: vi.fn() }, { onWrite }))
    paste(element, "a".repeat(20_000))
    expect(onWrite.mock.calls).toEqual([["a".repeat(4096)]])
    paste(element, "replacement")
    vi.runAllTimers()
    expect(onWrite.mock.calls).toEqual([["a".repeat(4096)], ["replacement"]])
  })

  test("disposal stops pending chunks and removes the capture handler", () => {
    const element = textarea()
    const onWrite = vi.fn()
    const nativePaste = vi.fn()
    element.addEventListener("paste", nativePaste)
    const dispose = setupPasteHandler({ textarea: element, paste: vi.fn() }, { onWrite })
    cleanups.push(dispose)
    paste(element, "a".repeat(20_000))
    dispose()
    vi.runAllTimers()
    paste(element, "after cleanup")
    expect(onWrite.mock.calls).toEqual([["a".repeat(4096)]])
    expect(nativePaste).toHaveBeenCalledTimes(1)
  })
})
