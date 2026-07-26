/**
 * Glyph geometry engine.
 *
 * Icons are authored as geometric primitives on a 20x20 canvas rather than as
 * flattened `d` strings, so that presentation — stroke weight, cap, join and
 * above all CORNER RADIUS — stays a parameter instead of being frozen into the
 * path at authoring time.
 *
 * On corner radius specifically: `stroke-linejoin="round"` is not the same
 * knob. It rounds the outer envelope of the stroke at a joint, and its radius
 * is always half the stroke width — at a 1.5 stroke that is 0.75 units, far
 * tighter than the 1–2 unit geometric radius a rounded icon set actually uses.
 * A settable corner therefore has to be built into the path, which is what
 * `roundedPolyline` below does.
 */

export type Point = readonly [number, number]

/**
 * Every collection here is `readonly` because shapes are authored with
 * `as const`, which is what keeps shape names literal for the binding table.
 * Accepting readonly input lets authored data flow in without a cast.
 */
export type Primitive =
  /** Open or closed polyline. Interior vertices are corner-rounded by `corner`. */
  | { readonly k: "poly"; readonly pts: readonly Point[]; readonly close?: boolean }
  /** Full circle. */
  | { readonly k: "circle"; readonly c: Point; readonly r: number }
  /** Axis-aligned rectangle. `r` is scaled by the style's `rectRadius` factor. */
  | {
      readonly k: "rect"
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly r?: number
    }
  /** Circular arc, angles in degrees, 0° = east, increasing clockwise (SVG y-down). */
  | { readonly k: "arc"; readonly c: Point; readonly r: number; readonly from: number; readonly to: number }
  /** Always-filled dot, immune to stroke styling. */
  | { readonly k: "dot"; readonly c: Point; readonly r: number }

export type Glyph = {
  readonly prims: readonly Primitive[]
  /** Render with fill instead of stroke (solid marks: pin-filled, stop, play). */
  readonly filled?: boolean
}

export type GlyphStyle = {
  strokeWidth: number
  cap: "round" | "square" | "butt"
  join: "round" | "miter" | "bevel"
  /**
   * Geometric corner radius in canvas units, applied to polyline vertices.
   * 0 gives a hard corner; ~2 is about as round as a 20-unit glyph tolerates
   * before short segments collapse.
   */
  corner: number
  /** Multiplier on each rect's authored corner radius. */
  rectRadius: number
}

export const GLYPH_STYLES = {
  /** Soft, humanist. Round caps and joins, generous geometric corners. */
  round: { strokeWidth: 1.5, cap: "round", join: "round", corner: 1.6, rectRadius: 1 },
  /** Technical, precise. Square caps, mitered joins, hard corners. */
  sharp: { strokeWidth: 1.25, cap: "square", join: "miter", corner: 0, rectRadius: 0.35 },
} as const satisfies Record<string, GlyphStyle>

export type GlyphStyleName = keyof typeof GLYPH_STYLES

/** Trim float noise so emitted paths stay compact and diff cleanly. */
function n(value: number) {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? "0" : String(rounded)
}

function pt(p: Point) {
  return `${n(p[0])} ${n(p[1])}`
}

function sub(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]]
}

function length(v: Point) {
  return Math.hypot(v[0], v[1])
}

function scale(v: Point, factor: number): Point {
  return [v[0] * factor, v[1] * factor]
}

function add(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1]]
}

/**
 * Emit a polyline whose interior vertices are rounded to `corner` units.
 *
 * At each vertex B between A and C we walk back along BA and forward along BC
 * by the same distance, then bridge those two tangent points with a quadratic
 * whose control point is B itself. A quadratic (rather than a true circular
 * arc) is what icon tooling conventionally uses here: for the shallow-to-right
 * angles glyphs actually contain the difference is not perceptible at 16–20px,
 * and it keeps the emitted path a third shorter.
 *
 * The radius is clamped per-corner to half of the shorter adjacent segment, so
 * a large `corner` degrades gracefully on tight geometry instead of letting
 * neighbouring corners overrun each other and invert the outline.
 */
function roundedPolyline(pts: readonly Point[], close: boolean, corner: number) {
  if (pts.length < 2) return ""
  if (corner <= 0) {
    return `M${pt(pts[0]!)}${pts.slice(1).map((p) => `L${pt(p)}`).join("")}${close ? "Z" : ""}`
  }

  // A closed ring rounds every vertex; an open run leaves its endpoints square.
  const last = pts.length - 1
  const indices = close ? pts.map((_, i) => i) : pts.slice(1, last).map((_, i) => i + 1)
  const rounds = new Map<number, { in: Point; out: Point }>()

  for (const i of indices) {
    const b = pts[i]!
    const a = pts[(i - 1 + pts.length) % pts.length]!
    const c = pts[(i + 1) % pts.length]!
    const toA = sub(a, b)
    const toC = sub(c, b)
    const lenA = length(toA)
    const lenC = length(toC)
    if (lenA === 0 || lenC === 0) continue

    // Collinear vertices have no corner to round; rounding them would bow a
    // straight run outward.
    const cross = (toA[0] * toC[1] - toA[1] * toC[0]) / (lenA * lenC)
    if (Math.abs(cross) < 1e-6) continue

    const radius = Math.min(corner, lenA / 2, lenC / 2)
    rounds.set(i, {
      in: add(b, scale(toA, radius / lenA)),
      out: add(b, scale(toC, radius / lenC)),
    })
  }

  const start = rounds.get(0)?.out ?? pts[0]!
  let d = `M${pt(start)}`
  for (let step = 1; step <= last; step++) {
    const round = rounds.get(step)
    if (!round) {
      d += `L${pt(pts[step]!)}`
      continue
    }
    d += `L${pt(round.in)}Q${pt(pts[step]!)} ${pt(round.out)}`
  }

  if (!close) return d

  const first = rounds.get(0)
  if (!first) return `${d}Z`
  return `${d}L${pt(first.in)}Q${pt(pts[0]!)} ${pt(first.out)}Z`
}

function circlePath(c: Point, r: number) {
  const [cx, cy] = c
  return `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`
}

function rectPath(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  if (radius === 0) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`
  return [
    `M${n(x + radius)} ${n(y)}`,
    `H${n(x + w - radius)}`,
    `A${n(radius)} ${n(radius)} 0 0 1 ${n(x + w)} ${n(y + radius)}`,
    `V${n(y + h - radius)}`,
    `A${n(radius)} ${n(radius)} 0 0 1 ${n(x + w - radius)} ${n(y + h)}`,
    `H${n(x + radius)}`,
    `A${n(radius)} ${n(radius)} 0 0 1 ${n(x)} ${n(y + h - radius)}`,
    `V${n(y + radius)}`,
    `A${n(radius)} ${n(radius)} 0 0 1 ${n(x + radius)} ${n(y)}`,
    "Z",
  ].join("")
}

function polar(c: Point, r: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180
  return [c[0] + r * Math.cos(radians), c[1] + r * Math.sin(radians)]
}

function arcPath(c: Point, r: number, from: number, to: number) {
  const sweep = to - from
  // A full turn has no distinct endpoints for the arc command to bridge.
  if (Math.abs(sweep) >= 360) return circlePath(c, r)
  const start = polar(c, r, from)
  const end = polar(c, r, to)
  const large = Math.abs(sweep) > 180 ? 1 : 0
  const direction = sweep >= 0 ? 1 : 0
  return `M${pt(start)}A${n(r)} ${n(r)} 0 ${large} ${direction} ${pt(end)}`
}

/** Render one primitive to path data under the given style. */
export function primitivePath(prim: Primitive, style: GlyphStyle): string {
  switch (prim.k) {
    case "poly":
      return roundedPolyline(prim.pts, prim.close ?? false, style.corner)
    case "circle":
      return circlePath(prim.c, prim.r)
    case "rect":
      return rectPath(prim.x, prim.y, prim.w, prim.h, (prim.r ?? 0) * style.rectRadius)
    case "arc":
      return arcPath(prim.c, prim.r, prim.from, prim.to)
    case "dot":
      return circlePath(prim.c, prim.r)
  }
}

export type RenderedGlyph = {
  /** Stroked outline, empty when the glyph is entirely dots or filled. */
  stroke: string
  /** Filled regions: always-solid dots, plus the whole glyph when `filled`. */
  fill: string
  attributes: {
    "stroke-width": string
    "stroke-linecap": GlyphStyle["cap"]
    "stroke-linejoin": GlyphStyle["join"]
  }
}

/**
 * Render a glyph to fill/stroke path data under a style.
 *
 * Dots are separated out because a dot is a solid mark by intent: stroking it
 * would give a 1.6-unit dot a 1.5-unit ring and a pinhole centre.
 */
export function renderGlyph(glyph: Glyph, style: GlyphStyle): RenderedGlyph {
  const dots = glyph.prims.filter((prim) => prim.k === "dot")
  const rest = glyph.prims.filter((prim) => prim.k !== "dot")
  const restPath = rest.map((prim) => primitivePath(prim, style)).join("")
  const dotPath = dots.map((prim) => primitivePath(prim, style)).join("")

  return {
    stroke: glyph.filled ? "" : restPath,
    fill: [glyph.filled ? restPath : "", dotPath].filter(Boolean).join(""),
    attributes: {
      "stroke-width": n(style.strokeWidth),
      "stroke-linecap": style.cap,
      "stroke-linejoin": style.join,
    },
  }
}
