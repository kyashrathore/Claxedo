import { describe, expect, test } from "bun:test"
import { GLYPH_STYLES, ICON_BINDINGS, SHAPES, glyphIconNames, renderIcon, renderIconSprite } from "./index"
import type { IconBinding } from "./index"
import type { Primitive } from "./geometry"

/** `satisfies` keeps each entry's literal type, so widen to read `rotate`. */
const bindingFor = (name: keyof typeof ICON_BINDINGS) => ICON_BINDINGS[name] as IconBinding

const styles = Object.keys(GLYPH_STYLES) as (keyof typeof GLYPH_STYLES)[]

/** Authored extent of a shape, so bounds are checked at the source. */
function extent(prims: readonly Primitive[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const put = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const prim of prims) {
    if (prim.k === "poly") prim.pts.forEach(([x, y]) => put(x, y))
    else if (prim.k === "rect") {
      put(prim.x, prim.y)
      put(prim.x + prim.w, prim.y + prim.h)
    } else {
      put(prim.c[0] - prim.r, prim.c[1] - prim.r)
      put(prim.c[0] + prim.r, prim.c[1] + prim.r)
    }
  }
  return { minX, minY, maxX, maxY }
}

describe("icon bindings", () => {
  test("every binding points at a shape that exists", () => {
    for (const name of glyphIconNames) {
      expect(SHAPES[ICON_BINDINGS[name].shape], name).toBeDefined()
    }
  })

  test("no shape is authored without a binding", () => {
    const used = new Set(Object.values(ICON_BINDINGS).map((b) => b.shape))
    expect(Object.keys(SHAPES).filter((s) => !used.has(s as never))).toEqual([])
  })

  test("every icon renders to non-empty geometry in every style", () => {
    for (const style of styles) {
      for (const name of glyphIconNames) {
        const icon = renderIcon(name, style)
        expect(`${name}:${style}:${icon.stroke}${icon.fill}`.length, name).toBeGreaterThan(name.length + style.length + 2)
      }
    }
  })

  test("no icon emits NaN, Infinity or undefined", () => {
    for (const style of styles) {
      for (const name of glyphIconNames) {
        const { stroke, fill } = renderIcon(name, style)
        expect(`${stroke}${fill}`, `${name} @ ${style}`).not.toMatch(/NaN|Infinity|undefined/)
      }
    }
  })
})

describe("canvas discipline", () => {
  test("every shape stays inside the 20x20 canvas", () => {
    for (const [name, glyph] of Object.entries(SHAPES)) {
      const { minX, minY, maxX, maxY } = extent(glyph.prims)
      expect(minX, `${name} left`).toBeGreaterThanOrEqual(1)
      expect(minY, `${name} top`).toBeGreaterThanOrEqual(1)
      expect(maxX, `${name} right`).toBeLessThanOrEqual(19)
      expect(maxY, `${name} bottom`).toBeLessThanOrEqual(19)
    }
  })

  test("rotated bindings use a shape that is square enough to rotate cleanly", () => {
    // A shape rotated 90/270 swaps its axes; if it is not roughly square it
    // will overflow the canvas in its rotated orientation.
    for (const name of glyphIconNames) {
      const binding = bindingFor(name)
      if (binding.rotate !== 90 && binding.rotate !== 270) continue
      const { minX, minY, maxX, maxY } = extent(SHAPES[binding.shape].prims)
      // Rotating about (10,10) maps x-extent onto y and vice versa.
      expect(20 - maxY, `${name} rotated left`).toBeGreaterThanOrEqual(0.5)
      expect(minY, `${name} rotated right`).toBeGreaterThanOrEqual(0.5)
      expect(20 - maxX, `${name} rotated top`).toBeGreaterThanOrEqual(0.5)
      expect(minX, `${name} rotated bottom`).toBeGreaterThanOrEqual(0.5)
    }
  })
})

describe("style parameterisation", () => {
  test("the two presets produce different geometry, not just different attributes", () => {
    // If corner radius were not baked into the path, these would be identical
    // and the whole point of the system would be lost.
    const differing = glyphIconNames.filter(
      (name) => renderIcon(name, "round").stroke !== renderIcon(name, "sharp").stroke,
    )
    expect(differing.length).toBeGreaterThan(20)
  })

  test("sharp emits no curve commands for pure-polyline shapes", () => {
    // corner: 0 must produce literal vertices — no quadratics.
    const polylineOnly = glyphIconNames.filter((name) =>
      SHAPES[ICON_BINDINGS[name].shape].prims.every((p) => p.k === "poly"),
    )
    expect(polylineOnly.length).toBeGreaterThan(10)
    for (const name of polylineOnly) {
      expect(renderIcon(name, "sharp").stroke, name).not.toContain("Q")
    }
  })

  test("round emits curves wherever a shape actually has a corner", () => {
    const cornered = glyphIconNames.filter((name) =>
      SHAPES[ICON_BINDINGS[name].shape].prims.some((p) => p.k === "poly" && p.pts.length > 2),
    )
    for (const name of cornered) {
      // Filled glyphs carry their outline in `fill`, stroked ones in `stroke`.
      const icon = renderIcon(name, "round")
      expect(`${icon.stroke}${icon.fill}`, name).toContain("Q")
    }
  })

  test("corner radius is continuously adjustable, not a two-way switch", () => {
    const widths = [0, 0.5, 1, 2, 3].map(
      (corner) => renderIcon("folder", { ...GLYPH_STYLES.round, corner }).stroke,
    )
    expect(new Set(widths).size).toBe(widths.length)
  })

  test("stroke attributes follow the style", () => {
    expect(renderIcon("check", "round").attributes["stroke-linecap"]).toBe("round")
    expect(renderIcon("check", "sharp").attributes["stroke-linecap"]).toBe("square")
  })
})

describe("sprite assembly", () => {
  test("a sprite carries one symbol per catalog icon", () => {
    const sprite = renderIconSprite("round")
    expect(sprite.match(/<symbol /g)).toHaveLength(glyphIconNames.length)
    for (const name of glyphIconNames) expect(sprite).toContain(`id="glyph-${name}"`)
  })

  test("symbol ids are unique", () => {
    const ids = [...renderIconSprite("round").matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("rotation is applied via a wrapping group, not baked into coordinates", () => {
    const rotated = renderIcon("chevron-down", "round")
    const base = renderIcon("chevron-right", "round")
    expect(rotated.transform).toBe("rotate(90 10 10)")
    expect(base.transform).toBeUndefined()
    expect(rotated.stroke).toBe(base.stroke)
  })

  test("each sprite is self-contained markup with no external reference", () => {
    for (const style of styles) {
      const sprite = renderIconSprite(style)
      // The SVG namespace is the one permitted http:// token; nothing may be
      // fetched at render time.
      expect(sprite.replaceAll('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("http")
      expect(sprite).not.toMatch(/href=|url\(/)
      expect(sprite.startsWith("<svg")).toBe(true)
      expect(sprite.endsWith("</svg>")).toBe(true)
    }
  })
})
