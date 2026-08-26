import { describe, expect, test, vi } from "bun:test"
import { installOsc52ClipboardHandler } from "./osc52-clipboard"

const harness = () => {
  let handler: ((data: string) => boolean) | undefined
  const input = vi.fn()
  const dispose = vi.fn()
  const terminal = {
    input,
    parser: {
      registerOscHandler: vi.fn((_id: number, next: (data: string) => boolean) => {
        handler = next
        return { dispose }
      }),
    },
  }
  return { terminal, input, dispose, handle: (data: string) => handler?.(data) }
}

describe("installOsc52ClipboardHandler", () => {
  test("does not pause xterm parsing while a clipboard write is pending", async () => {
    const pending = Promise.withResolvers<void>()
    const clipboard = { readText: vi.fn(), writeText: vi.fn(() => pending.promise) }
    const h = harness()
    installOsc52ClipboardHandler(h.terminal, clipboard)

    expect(h.handle("c;SGVsbG8=")).toBe(true)
    expect(clipboard.writeText).toHaveBeenCalledWith("c", "Hello")

    pending.resolve()
    await pending.promise
  })

  test("acknowledges a clipboard query synchronously and responds when the read completes", async () => {
    const pending = Promise.withResolvers<string>()
    const clipboard = { readText: vi.fn(() => pending.promise), writeText: vi.fn() }
    const h = harness()
    installOsc52ClipboardHandler(h.terminal, clipboard)

    expect(h.handle("c;?")).toBe(true)
    expect(clipboard.readText).toHaveBeenCalledWith("c")
    expect(h.input).not.toHaveBeenCalled()

    pending.resolve("hello ✓")
    await pending.promise
    await Promise.resolve()
    expect(h.input).toHaveBeenCalledWith("\x1b]52;c;aGVsbG8g4pyT\x07", false)
  })

  test("does not deliver a late clipboard query response after disposal", async () => {
    const pending = Promise.withResolvers<string>()
    const clipboard = { readText: vi.fn(() => pending.promise), writeText: vi.fn() }
    const h = harness()
    const registration = installOsc52ClipboardHandler(h.terminal, clipboard)

    expect(h.handle("c;?")).toBe(true)
    registration.dispose()
    pending.resolve("late")
    await pending.promise
    await Promise.resolve()

    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(h.input).not.toHaveBeenCalled()
  })
})
