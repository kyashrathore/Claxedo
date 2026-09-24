import { expect, spyOn, test } from "bun:test"
import { clearOpaqueTimer } from "./async"

test("clearOpaqueTimer accepts numeric and Node timer handles and ignores other values", () => {
  const nodeTimer = setTimeout(() => {}, 60_000)
  const originalClear = globalThis.clearTimeout
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {})
  try {
    clearOpaqueTimer(17)
    clearOpaqueTimer(nodeTimer)
    clearOpaqueTimer(undefined)
    clearOpaqueTimer({})
    clearOpaqueTimer([])
    expect(clear).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenNthCalledWith(1, 17)
    expect(clear).toHaveBeenNthCalledWith(2, nodeTimer)
  } finally {
    clear.mockRestore()
    originalClear(nodeTimer)
  }
})
