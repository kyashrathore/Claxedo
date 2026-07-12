import { describe, expect, test } from "bun:test"
import {
  BP_2XL,
  BP_EDITOR_COMPACT,
  BP_EDITOR_WIDE,
  BP_LG,
  BP_MD,
  BP_SM,
  BP_XL,
  BP_XS,
  COARSE_POINTER_QUERY,
  isNarrowViewport,
  mediaQueryBelow,
} from "./breakpoints"

// The breakpoint tokens are the single source of truth every layout gate reads
// from. These tests pin the exact numeric values (a silent drift here would
// desync the parity guard's CSS/TS weld) and the two helpers callers use.

describe("breakpoint token values", () => {
  test("the five on-scale tokens equal the Tailwind default screens map", () => {
    expect({ BP_SM, BP_MD, BP_LG, BP_XL, BP_2XL }).toEqual({
      BP_SM: 640,
      BP_MD: 768,
      BP_LG: 1024,
      BP_XL: 1280,
      BP_2XL: 1536,
    })
  })

  test("the three off-scale editor tokens keep their bespoke values", () => {
    expect({ BP_EDITOR_WIDE, BP_EDITOR_COMPACT, BP_XS }).toEqual({
      BP_EDITOR_WIDE: 1200,
      BP_EDITOR_COMPACT: 900,
      BP_XS: 420,
    })
  })
})

describe("isNarrowViewport", () => {
  test("a width one pixel below BP_MD is narrow", () => {
    expect(isNarrowViewport(BP_MD - 1)).toBe(true)
  })

  test("exactly BP_MD is NOT narrow (the boundary belongs to the wide side)", () => {
    expect(isNarrowViewport(BP_MD)).toBe(false)
  })

  test("a wide desktop width is not narrow", () => {
    expect(isNarrowViewport(1440)).toBe(false)
  })

  test("undefined width (SSR) is treated as not-narrow", () => {
    expect(isNarrowViewport(undefined)).toBe(false)
  })
})

describe("mediaQueryBelow", () => {
  test("BP_MD produces the max-width complement of the 768px min-width boundary", () => {
    expect(mediaQueryBelow(BP_MD)).toBe("(max-width: 767px)")
  })

  test("BP_SM produces the 639px complement of the 640px boundary", () => {
    expect(mediaQueryBelow(BP_SM)).toBe("(max-width: 639px)")
  })

  test("COARSE_POINTER_QUERY is the touch/stylus pointer media query", () => {
    expect(COARSE_POINTER_QUERY).toBe("(pointer: coarse)")
  })
})
