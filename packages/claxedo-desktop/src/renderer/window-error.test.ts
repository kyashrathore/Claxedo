import { describe, expect, test } from "bun:test"
import { isResizeObserverDeliveryError } from "./window-error"

describe("isResizeObserverDeliveryError", () => {
  test("recognizes Chromium ResizeObserver delivery warnings", () => {
    expect(isResizeObserverDeliveryError("ResizeObserver loop completed with undelivered notifications.")).toBe(true)
    expect(isResizeObserverDeliveryError("ResizeObserver loop limit exceeded")).toBe(true)
  })

  test("does not suppress application errors", () => {
    expect(isResizeObserverDeliveryError("ResizeObserver is not defined")).toBe(false)
    expect(isResizeObserverDeliveryError("TypeError: cannot read properties of undefined")).toBe(false)
    expect(isResizeObserverDeliveryError("")).toBe(false)
  })
})
