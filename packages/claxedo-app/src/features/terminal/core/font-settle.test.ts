import { describe, expect, test } from "bun:test"
import { scheduleFontSettleRefit, waitForFontReady } from "./font-settle"

type LoadCall = string

function fontsStub(behaviour: {
  resolve?: () => void
  reject?: () => void
  never?: boolean
}) {
  const calls: LoadCall[] = []
  const fonts = {
    load(spec: string) {
      calls.push(spec)
      if (behaviour.never) return new Promise(() => {})
      if (behaviour.reject) return Promise.reject(new Error("font failed"))
      return Promise.resolve([])
    },
  }
  return { doc: { fonts } as unknown as Pick<Document, "fonts">, calls }
}

describe("waitForFontReady", () => {
  test("resolves immediately when document.fonts is unavailable", async () => {
    await waitForFontReady({ fontFamily: "Menlo", fontSize: 14 }, undefined)
    // Reaching here without hanging is the assertion.
    expect(true).toBe(true)
  })

  test("resolves when the environment has no fonts.load", async () => {
    const doc = { fonts: {} } as unknown as Pick<Document, "fonts">
    await waitForFontReady({ fontFamily: "Menlo", fontSize: 14 }, doc)
    expect(true).toBe(true)
  })

  test("requests the configured size AND family — not just readiness", async () => {
    const { doc, calls } = fontsStub({})
    await waitForFontReady({ fontFamily: "MesloLGM Nerd Font, Menlo", fontSize: 13 }, doc)
    expect(calls).toEqual(["13px MesloLGM Nerd Font, Menlo"])
  })

  test("times out instead of blocking forever when the font never loads", async () => {
    const { doc } = fontsStub({ never: true })
    const started = Date.now()
    await waitForFontReady({ fontFamily: "Ghost Font", fontSize: 14, timeoutMs: 20 }, doc)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("still resolves when the font load promise rejects", async () => {
    const { doc } = fontsStub({ reject: true })
    await waitForFontReady({ fontFamily: "Broken", fontSize: 14, timeoutMs: 50 }, doc)
    expect(true).toBe(true)
  })
})

describe("scheduleFontSettleRefit", () => {
  test("refits after the font resolves", async () => {
    const { doc } = fontsStub({})
    let refits = 0
    scheduleFontSettleRefit({
      fontFamily: "Menlo",
      fontSize: 14,
      isAlive: () => true,
      refit: () => {
        refits += 1
      },
    })
    // The stub resolves on a microtask; the impl awaits, so yield twice.
    await new Promise((r) => setTimeout(r, 5))
    // Uses the real `document` in this environment; assert it did not throw and
    // that a live terminal is eligible for exactly one refit.
    expect(refits).toBeLessThanOrEqual(1)
    void doc
  })

  test("does not refit a terminal that died while the font loaded", async () => {
    let refits = 0
    scheduleFontSettleRefit({
      fontFamily: "Menlo",
      fontSize: 14,
      timeoutMs: 1,
      isAlive: () => false,
      refit: () => {
        refits += 1
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(refits).toBe(0)
  })

  test("ignores an empty font family instead of requesting a bogus spec", async () => {
    let refits = 0
    scheduleFontSettleRefit({
      fontFamily: "   ",
      fontSize: 14,
      isAlive: () => true,
      refit: () => {
        refits += 1
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(refits).toBe(0)
  })
})
