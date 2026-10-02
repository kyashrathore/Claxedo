import { expect, test } from "bun:test"
import { quoteBoxPosition, visibleBounds } from "./selected-quote"

const surface = { top: 0, bottom: 800, left: 200, right: 900 }
const viewport = { width: 1000, height: 900 }

test("the box opens under the selection, at its left edge", () => {
  expect(quoteBoxPosition({ top: 100, bottom: 120, left: 300, right: 500 }, surface, viewport)).toEqual({ left: 300, width: 320, top: 128 })
})

test("with no room for the grown box below, it sits just above the selection and grows upward", () => {
  expect(quoteBoxPosition({ top: 700, bottom: 720, left: 300, right: 500 }, surface, viewport)).toEqual({ left: 300, width: 320, bottom: 208 })
})

test("the box stays inside the surface's sides and shrinks to a narrow surface", () => {
  expect(quoteBoxPosition({ top: 100, bottom: 120, left: 880, right: 890 }, surface, viewport).left).toBe(572)
  expect(quoteBoxPosition({ top: 100, bottom: 120, left: 10, right: 50 }, { ...surface, left: 0, right: 200 }, viewport)).toEqual({ left: 8, width: 184, top: 128 })
})

test("a selection scrolled above the surface pins the box to the surface's top", () => {
  expect(quoteBoxPosition({ top: -400, bottom: -380, left: 300, right: 500 }, surface, viewport)).toEqual({ left: 300, width: 320, top: 8 })
})

test("a selection scrolled below the surface keeps the whole box inside it", () => {
  expect(quoteBoxPosition({ top: 1200, bottom: 1220, left: 300, right: 500 }, surface, viewport)).toEqual({ left: 300, width: 320, bottom: 108 })
})

test("the surface is its clipping area cut to the window, or the window when nothing clips", () => {
  expect(visibleBounds({ top: -50, bottom: 2000, left: -10, right: 700 }, { width: 640, height: 900 })).toEqual({ top: 0, bottom: 900, left: 0, right: 640 })
  expect(visibleBounds(undefined, { width: 640, height: 900 })).toEqual({ top: 0, bottom: 900, left: 0, right: 640 })
})
