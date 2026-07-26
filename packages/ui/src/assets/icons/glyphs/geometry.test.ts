import { describe, expect, test } from "bun:test"
import { GLYPH_STYLES, primitivePath, renderGlyph, type GlyphStyle, type Point } from "./geometry"

const sharp = GLYPH_STYLES.sharp
const round = GLYPH_STYLES.round

/** Every coordinate pair in a path, for geometric assertions on the output. */
function coordinates(d: string): Point[] {
  return [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
}

describe("corner rounding", () => {
  const elbow: Point[] = [
    [4, 4],
    [4, 16],
    [16, 16],
  ]

  test("corner 0 emits the literal vertices", () => {
    expect(primitivePath({ k: "poly", pts: elbow }, sharp)).toBe("M4 4L4 16L16 16")
  })

  test("a rounded corner replaces the vertex with a tangent-to-tangent curve", () => {
    const d = primitivePath({ k: "poly", pts: elbow }, { ...round, corner: 2 })
    // Walk back 2 along the incoming leg and forward 2 along the outgoing leg,
    // bridging with a quadratic controlled by the original vertex.
    expect(d).toBe("M4 4L4 14Q4 16 6 16L16 16")
  })

  test("endpoints of an open run stay square", () => {
    const d = primitivePath({ k: "poly", pts: elbow }, { ...round, corner: 2 })
    const points = coordinates(d)
    expect(points.at(0)).toEqual([4, 4])
    expect(points.at(-1)).toEqual([16, 16])
  })

  test("radius is clamped to half the shorter adjacent leg", () => {
    // The vertical leg is only 2 long, so a requested radius of 5 must collapse
    // to 1 — otherwise adjacent corners overrun and the outline inverts.
    const tight: Point[] = [
      [4, 4],
      [4, 6],
      [16, 6],
    ]
    const d = primitivePath({ k: "poly", pts: tight }, { ...round, corner: 5 })
    expect(d).toBe("M4 4L4 5Q4 6 5 6L16 6")
  })

  test("collinear vertices are left alone", () => {
    const straight: Point[] = [
      [4, 10],
      [10, 10],
      [16, 10],
    ]
    expect(primitivePath({ k: "poly", pts: straight }, { ...round, corner: 2 })).toBe("M4 10L10 10L16 10")
  })

  test("a closed ring rounds every vertex including the seam", () => {
    const square: Point[] = [
      [5, 5],
      [15, 5],
      [15, 15],
      [5, 15],
    ]
    const d = primitivePath({ k: "poly", pts: square, close: true }, { ...round, corner: 2 })
    // One quadratic per vertex, and the ring starts mid-edge at a tangent point
    // rather than on the seam corner.
    expect(d).toBe("M7 5L13 5Q15 5 15 7L15 13Q15 15 13 15L7 15Q5 15 5 13L5 7Q5 5 7 5Z")
    expect(d.match(/Q/g)).toHaveLength(4)
    expect(d.endsWith("Z")).toBe(true)

    // Corners survive only as quadratic CONTROL points — no on-path coordinate
    // sits on a corner of the source square any more.
    const onPath = d.replace(/Q[-\d. ]+ /g, "Q")
    for (const [x, y] of coordinates(onPath)) {
      expect([x === 5 || x === 15, y === 5 || y === 15].filter(Boolean).length).toBeLessThan(2)
    }
  })

  test("rounding never moves geometry outside the source hull", () => {
    // Rounding cuts corners inward; it must never bulge past the original.
    const shape: Point[] = [
      [3, 17],
      [3, 3],
      [17, 3],
      [17, 17],
    ]
    for (const corner of [0, 0.5, 1.6, 3, 6]) {
      const d = primitivePath({ k: "poly", pts: shape, close: true }, { ...round, corner })
      for (const [x, y] of coordinates(d)) {
        expect(x).toBeGreaterThanOrEqual(3)
        expect(x).toBeLessThanOrEqual(17)
        expect(y).toBeGreaterThanOrEqual(3)
        expect(y).toBeLessThanOrEqual(17)
      }
    }
  })
})

describe("primitives", () => {
  test("a rect's radius scales with the style", () => {
    const rect = { k: "rect", x: 4, y: 4, w: 12, h: 12, r: 2 } as const
    expect(primitivePath(rect, { ...sharp, rectRadius: 0 })).toBe("M4 4H16V16H4Z")
    expect(primitivePath(rect, { ...round, rectRadius: 1 })).toContain("A2 2")
    expect(primitivePath(rect, { ...round, rectRadius: 0.5 })).toContain("A1 1")
  })

  test("rect radius is clamped to half the shorter side", () => {
    const d = primitivePath({ k: "rect", x: 5, y: 8, w: 10, h: 4, r: 9 }, { ...round, rectRadius: 1 })
    expect(d).toContain("A2 2")
  })

  test("a 360 degree arc closes into a circle", () => {
    const asArc = primitivePath({ k: "arc", c: [10, 10], r: 6, from: 0, to: 360 }, sharp)
    const asCircle = primitivePath({ k: "circle", c: [10, 10], r: 6 }, sharp)
    expect(asArc).toBe(asCircle)
  })

  test("arc direction follows the sign of the sweep", () => {
    const clockwise = primitivePath({ k: "arc", c: [10, 10], r: 6, from: 0, to: 90 }, sharp)
    const anticlockwise = primitivePath({ k: "arc", c: [10, 10], r: 6, from: 0, to: -90 }, sharp)
    expect(clockwise).toContain("0 0 1")
    expect(anticlockwise).toContain("0 0 0")
  })

  test("the large-arc flag turns on past a half turn", () => {
    expect(primitivePath({ k: "arc", c: [10, 10], r: 6, from: 0, to: 90 }, sharp)).toContain("0 0 1")
    expect(primitivePath({ k: "arc", c: [10, 10], r: 6, from: 0, to: 270 }, sharp)).toContain("0 1 1")
  })
})

describe("rendering", () => {
  test("dots are filled, never stroked", () => {
    const rendered = renderGlyph({ prims: [{ k: "dot", c: [10, 10], r: 1.6 }] }, round)
    expect(rendered.stroke).toBe("")
    expect(rendered.fill).not.toBe("")
  })

  test("a filled glyph moves its outline into fill", () => {
    const prims = [{ k: "poly", pts: [[6, 6], [14, 6], [14, 14]], close: true }] as const
    const stroked = renderGlyph({ prims: [...prims] }, round)
    const filled = renderGlyph({ prims: [...prims], filled: true }, round)
    expect(stroked.fill).toBe("")
    expect(filled.stroke).toBe("")
    expect(filled.fill).toBe(stroked.stroke)
  })

  test("a mixed glyph keeps dots filled while the rest strokes", () => {
    const rendered = renderGlyph(
      {
        prims: [
          { k: "circle", c: [10, 10], r: 7 },
          { k: "dot", c: [10, 10], r: 1.2 },
        ],
      },
      round,
    )
    expect(rendered.stroke).not.toBe("")
    expect(rendered.fill).not.toBe("")
  })

  test("style presets reach the emitted attributes", () => {
    const glyph = { prims: [{ k: "poly", pts: [[4, 10] as Point, [16, 10] as Point] }] } as const
    expect(renderGlyph({ ...glyph, prims: [...glyph.prims] }, round).attributes).toEqual({
      "stroke-width": "1.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })
    expect(renderGlyph({ ...glyph, prims: [...glyph.prims] }, sharp).attributes).toEqual({
      "stroke-width": "1.25",
      "stroke-linecap": "square",
      "stroke-linejoin": "miter",
    })
  })
})

describe("output hygiene", () => {
  const styles: GlyphStyle[] = [round, sharp, { ...round, corner: 4 }, { ...sharp, corner: 0.4 }]

  test("no NaN, Infinity or negative zero reaches the path data", () => {
    const prims = [
      { k: "poly", pts: [[3, 3], [10, 3], [10, 10], [3, 10]], close: true },
      { k: "poly", pts: [[0, 0], [20, 20]] },
      { k: "circle", c: [10, 10], r: 0.5 },
      { k: "rect", x: 0, y: 0, w: 20, h: 20, r: 3 },
      { k: "arc", c: [10, 10], r: 6, from: -120, to: 200 },
      { k: "dot", c: [10, 10], r: 1 },
    ] as const

    for (const style of styles) {
      for (const prim of prims) {
        const d = primitivePath(prim, style)
        expect(d).not.toContain("NaN")
        expect(d).not.toContain("Infinity")
        expect(d).not.toContain("-0 ")
        expect(d.length).toBeGreaterThan(0)
      }
    }
  })

  test("degenerate input does not throw", () => {
    expect(primitivePath({ k: "poly", pts: [] }, round)).toBe("")
    expect(primitivePath({ k: "poly", pts: [[10, 10]] }, round)).toBe("")
    // A doubled vertex has no direction to round toward; it must be skipped.
    expect(() => primitivePath({ k: "poly", pts: [[4, 4], [4, 4], [16, 16]] }, round)).not.toThrow()
  })
})
