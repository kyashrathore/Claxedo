import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { scheduleFontSettleRefit, waitForFontReady } from "./font-settle"

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts")

function deferredFont() {
  let resolve!: (fonts: FontFace[]) => void
  let reject!: (error: Error) => void
  const pending = new Promise<FontFace[]>((yes, no) => { resolve = yes; reject = no })
  const load = vi.fn(() => pending)
  const fonts = { load }
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true })
  return { load, resolve, reject }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts)
  else Reflect.deleteProperty(document, "fonts")
})

describe("waitForFontReady", () => {
  test.each([{}, { fonts: {} }])("settles without a usable font API", async (doc) => {
    await expect(waitForFontReady({ fontFamily: "Menlo", fontSize: 14 }, doc as Pick<Document, "fonts">))
      .resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("waits for the requested size and family and cancels its deadline after loading", async () => {
    const font = deferredFont()
    const settled = vi.fn()
    const ready = waitForFontReady({ fontFamily: "MesloLGM Nerd Font, Menlo", fontSize: 13 }).then(settled)
    expect(font.load).toHaveBeenCalledWith("13px MesloLGM Nerd Font, Menlo")
    await vi.advanceTimersByTimeAsync(19)
    expect(settled).not.toHaveBeenCalled()
    font.resolve([])
    await ready
    expect(settled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("settles at the timeout when the font never loads", async () => {
    deferredFont()
    const settled = vi.fn()
    const ready = waitForFontReady({ fontFamily: "Ghost", fontSize: 14, timeoutMs: 20 }).then(settled)
    await vi.advanceTimersByTimeAsync(19)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await ready
    expect(settled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("settles and clears the timer when loading rejects", async () => {
    const font = deferredFont()
    const ready = waitForFontReady({ fontFamily: "Broken", fontSize: 14 })
    font.reject(new Error("font failed"))
    await expect(ready).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("scheduleFontSettleRefit", () => {
  test("refits exactly once after the actual document font resolves", async () => {
    const font = deferredFont()
    const refit = vi.fn()
    scheduleFontSettleRefit({ fontFamily: " Menlo ", fontSize: 14, isAlive: () => true, refit })
    expect(font.load).toHaveBeenCalledWith("14px Menlo")
    await vi.advanceTimersByTimeAsync(10)
    expect(refit).not.toHaveBeenCalled()
    font.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(refit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(refit).toHaveBeenCalledTimes(1)
  })

  test("does not refit a terminal that died while its font was loading", async () => {
    const font = deferredFont()
    const refit = vi.fn()
    let alive = true
    scheduleFontSettleRefit({ fontFamily: "Menlo", fontSize: 14, isAlive: () => alive, refit })
    alive = false
    font.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(refit).not.toHaveBeenCalled()
  })

  test("ignores an empty font family without asking the browser to load", async () => {
    const font = deferredFont()
    const refit = vi.fn()
    scheduleFontSettleRefit({ fontFamily: "   ", fontSize: 14, isAlive: () => true, refit })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(font.load).not.toHaveBeenCalled()
    expect(refit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
