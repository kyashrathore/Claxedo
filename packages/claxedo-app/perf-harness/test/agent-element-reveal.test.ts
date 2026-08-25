import { describe, expect, test } from "bun:test"
import {
  minimalRevealDelta,
  revealElement,
  revealScrollPlan,
  type RevealFrame,
} from "../src/agent-element-reveal"

const frame = (input: {
  top: number
  bottom: number
  viewTop: number
  viewBottom: number
  scrollTop?: number
  maxScrollTop?: number
  left?: number
  right?: number
  viewLeft?: number
  viewRight?: number
  scrollLeft?: number
  maxScrollLeft?: number
}): RevealFrame => ({
  element: {
    vertical: { start: input.top, end: input.bottom },
    horizontal: { start: input.left ?? 0, end: input.right ?? 100 },
  },
  view: {
    vertical: { start: input.viewTop, end: input.viewBottom },
    horizontal: { start: input.viewLeft ?? 0, end: input.viewRight ?? 100 },
  },
  scroll: { top: input.scrollTop ?? 1_000, left: input.scrollLeft ?? 0 },
  maxScroll: { top: input.maxScrollTop ?? 10_000, left: input.maxScrollLeft ?? 0 },
})

describe("minimal reveal delta", () => {
  test("a fully visible element is never scrolled", () => {
    expect(minimalRevealDelta({ start: 120, end: 160 }, { start: 100, end: 500 })).toBe(0)
    // Flush against either edge still counts as fully visible.
    expect(minimalRevealDelta({ start: 100, end: 160 }, { start: 100, end: 500 })).toBe(0)
    expect(minimalRevealDelta({ start: 440, end: 500 }, { start: 100, end: 500 })).toBe(0)
  })

  test("scrolls by the nearest edge only, never to the centre", () => {
    // Above the view: lift it just far enough to touch the top edge. Centring
    // would move it by 180px instead of 30px.
    expect(minimalRevealDelta({ start: 70, end: 110 }, { start: 100, end: 500 })).toBe(-30)
    // Below the view: drop it just far enough to touch the bottom edge.
    expect(minimalRevealDelta({ start: 480, end: 540 }, { start: 100, end: 500 })).toBe(40)
  })

  test("aligns the leading edge of an element too large to fit", () => {
    expect(minimalRevealDelta({ start: 60, end: 900 }, { start: 100, end: 500 })).toBe(-40)
  })
})

describe("reveal scroll plan", () => {
  test("plans nothing for a row already fully inside its scroller", () => {
    expect(revealScrollPlan([frame({ top: 120, bottom: 160, viewTop: 100, viewBottom: 500 })])).toBeUndefined()
  })

  test("plans the innermost scroller that still needs to move", () => {
    const plan = revealScrollPlan([
      frame({ top: 120, bottom: 160, viewTop: 100, viewBottom: 500 }),
      frame({ top: 120, bottom: 160, viewTop: 200, viewBottom: 800 }),
    ])
    expect(plan).toEqual({ depth: 1, top: -80, left: 0 })
  })

  test("clamps to what the scroller can actually deliver", () => {
    // The row sits 300px above the view but the scroller is only 40px from its
    // own top: asking for -300 would never settle.
    expect(
      revealScrollPlan([frame({ top: -200, bottom: -160, viewTop: 100, viewBottom: 500, scrollTop: 40 })]),
    ).toEqual({ depth: 0, top: -40, left: 0 })
  })

  test("treats a scroller already at its limit as done and moves outward", () => {
    const plan = revealScrollPlan([
      // Pinned at scrollTop 0 and still short: unrevealable, so skip it.
      frame({ top: -200, bottom: -160, viewTop: 100, viewBottom: 500, scrollTop: 0 }),
      frame({ top: -200, bottom: -160, viewTop: 0, viewBottom: 900, scrollTop: 500 }),
    ])
    expect(plan).toEqual({ depth: 1, top: -200, left: 0 })
  })

  test("ignores sub-pixel overflow instead of chasing it forever", () => {
    expect(
      revealScrollPlan([frame({ top: 100, bottom: 500.3, viewTop: 100, viewBottom: 500 })]),
    ).toBeUndefined()
  })

  test("plans a horizontal reveal on the same nearest terms", () => {
    expect(
      revealScrollPlan([
        frame({
          top: 120,
          bottom: 160,
          viewTop: 100,
          viewBottom: 500,
          left: 620,
          right: 700,
          viewLeft: 0,
          viewRight: 640,
          maxScrollLeft: 400,
        }),
      ]),
    ).toEqual({ depth: 0, top: 0, left: 60 })
  })
})

describe("reveal element", () => {
  /**
   * A page whose measurements are scripted per round, recording every browser
   * step the reveal takes. `evaluate` is distinguished by which argument shape
   * it receives, matching the two browser halves of the reveal.
   */
  const scriptedPage = (rounds: Array<RevealFrame[] | null>) => {
    const applied: Array<{ depth: number; top: number; left: number }> = []
    let measurements = 0
    const page = {
      evaluate: async (_fn: unknown, arg?: unknown) => {
        const input = arg as Record<string, unknown>
        if (typeof input.depth === "number") {
          applied.push({ depth: input.depth, top: input.top as number, left: input.left as number })
          return undefined as never
        }
        const round = rounds[Math.min(measurements++, rounds.length - 1)]
        return round as never
      },
    }
    return { page, applied, measured: () => measurements }
  }

  test("touches no scroll offset when the row is already fully visible", async () => {
    const scripted = scriptedPage([[frame({ top: 120, bottom: 160, viewTop: 100, viewBottom: 500 })]])
    await revealElement(scripted.page, "[data-row]", 0)
    expect(scripted.applied).toEqual([])
    expect(scripted.measured()).toBe(1)
  })

  test("re-measures after each scroll and stops once the row is revealed", async () => {
    const scripted = scriptedPage([
      [frame({ top: 900, bottom: 960, viewTop: 100, viewBottom: 500 })],
      // Virtualization re-laid the list out mid-reveal and left it short.
      [frame({ top: 520, bottom: 580, viewTop: 100, viewBottom: 500 })],
      [frame({ top: 440, bottom: 500, viewTop: 100, viewBottom: 500 })],
    ])
    await revealElement(scripted.page, "[data-row]", 0)
    expect(scripted.applied).toEqual([
      { depth: 0, top: 460, left: 0 },
      { depth: 0, top: 80, left: 0 },
    ])
  })

  test("scrolls nothing for an element with no scrollable ancestor to move", async () => {
    // What the browser half reports for an unrendered row: no frames at all.
    const scripted = scriptedPage([[]])
    await revealElement(scripted.page, "[data-row]", 1)
    expect(scripted.applied).toEqual([])
  })

  test("fails loudly when the target is not in the document", async () => {
    const scripted = scriptedPage([null])
    await expect(revealElement(scripted.page, "[data-row]", 3)).rejects.toThrow(
      "Claxedo reveal target is missing: [data-row][3]",
    )
  })

  test("fails loudly when a reveal never converges", async () => {
    // A scroller that reports the same unrevealed geometry forever.
    const scripted = scriptedPage([[frame({ top: 900, bottom: 960, viewTop: 100, viewBottom: 500 })]])
    await expect(revealElement(scripted.page, "[data-row]", 0)).rejects.toThrow(
      "Claxedo reveal did not converge for [data-row][0]",
    )
  })
})
