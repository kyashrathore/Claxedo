import type { Glyph, Point } from "./geometry"

/**
 * Outline of a gear: `teeth` tips at `outer`, the same number of valleys at
 * `inner`, each held flat across `flat` of its pitch so the tooth has a face
 * rather than a point.
 */
function gearRing(teeth: number, outer: number, inner: number, flat: number): Point[] {
  const pitch = (Math.PI * 2) / teeth
  const half = (pitch * flat) / 2
  const at = (angle: number, radius: number): Point => [
    10 + radius * Math.cos(angle),
    10 + radius * Math.sin(angle),
  ]
  return Array.from({ length: teeth }, (_, i) => {
    const tip = i * pitch
    const valley = tip + pitch / 2
    return [
      at(tip - half, outer),
      at(tip + half, outer),
      at(valley - half, inner),
      at(valley + half, inner),
    ]
  }).flat()
}

/**
 * Base glyph geometry.
 *
 * Every shape here is authored from geometric primitives on a 20x20 canvas with
 * a 3-unit margin, so the live area is 3..17 and the optical centre is 10,10.
 * Nothing in this file is traced from another icon set: a chevron is two
 * segments, a plus is two crossed runs, a magnifying glass is a circle and a
 * tangent handle. Shapes that only differ by rotation are declared once and
 * rotated at the callsite (see SHAPE_ROTATION in ./index.ts).
 *
 * Conventions:
 * - horizontal/vertical runs land on integers or .5 so a 1.25 stroke stays crisp;
 * - circular marks use r=7 for full-bleed and r=5.5 for inset;
 * - "small" variants shrink the live area to 5..15 rather than scaling a copy.
 */
export const SHAPES = {
  // ---------------------------------------------------------------- chevrons
  /** Single chevron pointing east. All four directions rotate from this. */
  chevron: { prims: [{ k: "poly", pts: [[8, 4.5], [13.5, 10], [8, 15.5]] }] },
  /** Two nested chevrons, for jump-to-end and rail collapse. */
  "chevron-double": {
    prims: [
      { k: "poly", pts: [[5, 5.5], [9.5, 10], [5, 14.5]] },
      { k: "poly", pts: [[11, 5.5], [15.5, 10], [11, 14.5]] },
    ],
  },
  /** Opposed chevrons — the select/combobox affordance. */
  "chevron-grabber": {
    prims: [
      { k: "poly", pts: [[6.5, 8.5], [10, 5], [13.5, 8.5]] },
      { k: "poly", pts: [[6.5, 11.5], [10, 15], [13.5, 11.5]] },
    ],
  },

  // ------------------------------------------------------------------ arrows
  /** Shaft plus head, pointing east. */
  arrow: {
    prims: [
      { k: "poly", pts: [[3.5, 10], [16, 10]] },
      { k: "poly", pts: [[11, 5], [16, 10], [11, 15]] },
    ],
  },
  /** Arrow into a baseline — download and scroll-to-latest. */
  "arrow-to-line": {
    prims: [
      { k: "poly", pts: [[10, 3], [10, 13]] },
      { k: "poly", pts: [[5.5, 8.5], [10, 13], [14.5, 8.5]] },
      { k: "poly", pts: [[4.5, 16.5], [15.5, 16.5]] },
    ],
  },
  /** Curved return arrow — undo, revert, reset. */
  "arrow-undo": {
    prims: [
      { k: "arc", c: [10, 11], r: 5.5, from: 180, to: 20 },
      { k: "poly", pts: [[4.5, 7], [4.5, 11], [8.5, 11]] },
    ],
  },
  /** Enter/return: shaft turning down into a head. */
  enter: {
    prims: [
      { k: "poly", pts: [[16, 5], [16, 12], [5, 12]] },
      { k: "poly", pts: [[9, 8], [5, 12], [9, 16]] },
    ],
  },
  /** Diagonal escape arrow inside a frame corner — open externally. */
  "square-arrow": {
    prims: [
      { k: "poly", pts: [[9, 5], [5, 5], [5, 15], [15, 15], [15, 11]] },
      { k: "poly", pts: [[11.5, 4.5], [15.5, 4.5], [15.5, 8.5]] },
      { k: "poly", pts: [[15.5, 4.5], [9.5, 10.5]] },
    ],
  },
  /** Two-way split — fork and worktree. */
  fork: {
    prims: [
      { k: "poly", pts: [[4.5, 10], [8.5, 10], [15, 4.5]] },
      { k: "poly", pts: [[8.5, 10], [15, 15.5]] },
      { k: "poly", pts: [[11.5, 4.5], [15.5, 4.5], [15.5, 8]] },
      { k: "poly", pts: [[11.5, 15.5], [15.5, 15.5], [15.5, 12]] },
    ],
  },
  /** Branch: a trunk with one commit spurring off it. */
  branch: {
    prims: [
      { k: "poly", pts: [[6.5, 6.5], [6.5, 15.5]] },
      { k: "circle", c: [6.5, 4.5], r: 2 },
      { k: "circle", c: [13.5, 4.5], r: 2 },
      { k: "poly", pts: [[11.5, 4.5], [6.5, 4.5]] },
      { k: "circle", c: [6.5, 15.5], r: 2 },
    ],
  },

  // -------------------------------------------------------------- primitives
  check: { prims: [{ k: "poly", pts: [[4.5, 10.5], [8.5, 14.5], [15.5, 5.5]] }] },
  "check-small": { prims: [{ k: "poly", pts: [[6, 10.25], [9, 13.25], [14, 6.75]] }] },
  xmark: { prims: [{ k: "poly", pts: [[5.5, 5.5], [14.5, 14.5]] }, { k: "poly", pts: [[14.5, 5.5], [5.5, 14.5]] }] },
  "xmark-small": {
    prims: [{ k: "poly", pts: [[6.75, 6.75], [13.25, 13.25]] }, { k: "poly", pts: [[13.25, 6.75], [6.75, 13.25]] }],
  },
  plus: { prims: [{ k: "poly", pts: [[10, 4], [10, 16]] }, { k: "poly", pts: [[4, 10], [16, 10]] }] },
  "plus-small": { prims: [{ k: "poly", pts: [[10, 5.5], [10, 14.5]] }, { k: "poly", pts: [[5.5, 10], [14.5, 10]] }] },
  dash: { prims: [{ k: "poly", pts: [[5, 10], [15, 10]] }] },
  circle: { prims: [{ k: "circle", c: [10, 10], r: 6.5 }] },
  /** Broken ring — a pending/unstarted state. */
  "circle-dashed": {
    prims: [30, 110, 190, 270].map((from) => ({ k: "arc", c: [10, 10], r: 6.5, from, to: from + 50 })),
  },
  /** Half-filled ring — partial/in-progress. */
  "circle-half": {
    prims: [
      { k: "circle", c: [10, 10], r: 6.5 },
      { k: "poly", pts: [[10, 3.5], [10, 16.5]] },
    ],
  },
  dot: { prims: [{ k: "dot", c: [10, 10], r: 3 }] },
  /** Solid square — the stop affordance. */
  stop: { prims: [{ k: "rect", x: 6, y: 6, w: 8, h: 8, r: 1.5 }], filled: true },
  /** Solid triangle — run/play. */
  play: { prims: [{ k: "poly", pts: [[7, 5], [16, 10], [7, 15]], close: true }], filled: true },

  // ------------------------------------------------------------------- dots
  kebab: { prims: [{ k: "dot", c: [10, 4.6], r: 1.55 }, { k: "dot", c: [10, 10], r: 1.55 }, { k: "dot", c: [10, 15.4], r: 1.55 }] },
  "more-horizontal": {
    prims: [{ k: "dot", c: [4.6, 10], r: 1.55 }, { k: "dot", c: [10, 10], r: 1.55 }, { k: "dot", c: [15.4, 10], r: 1.55 }],
  },
  /** Nine-dot grid — the marketplace/apps mark. */
  "dot-grid": {
    prims: [5.5, 10, 14.5].flatMap((y) => [5.5, 10, 14.5].map((x) => ({ k: "dot", c: [x, y] as [number, number], r: 1.15 }))),
  },

  // ------------------------------------------------------------ status rings
  "circle-alert": {
    prims: [
      { k: "circle", c: [10, 10], r: 6.5 },
      { k: "poly", pts: [[10, 6], [10, 10.5]] },
      { k: "dot", c: [10, 13.6], r: 0.85 },
    ],
  },
  "circle-check": {
    prims: [
      { k: "circle", c: [10, 10], r: 6.5 },
      { k: "poly", pts: [[6.5, 10], [9, 12.5], [13.5, 7.5]] },
    ],
  },
  "circle-x": {
    prims: [
      { k: "circle", c: [10, 10], r: 6.5 },
      { k: "poly", pts: [[7.5, 7.5], [12.5, 12.5]] },
      { k: "poly", pts: [[12.5, 7.5], [7.5, 12.5]] },
    ],
  },
  /** Ring with a single bar — the "no entry" mark. */
  "circle-ban": {
    prims: [
      { k: "circle", c: [10, 10], r: 6.5 },
      { k: "poly", pts: [[5.4, 14.6], [14.6, 5.4]] },
    ],
  },
  help: {
    prims: [
      { k: "circle", c: [10, 10], r: 6.5 },
      { k: "arc", c: [10, 8], r: 2.1, from: 170, to: 380 },
      { k: "poly", pts: [[10, 10.1], [10, 11.8]] },
      { k: "dot", c: [10, 14], r: 0.85 },
    ],
  },
  /** Triangle with a bang — warnings. */
  warning: {
    prims: [
      { k: "poly", pts: [[10, 4], [17, 16], [3, 16]], close: true },
      { k: "poly", pts: [[10, 8.5], [10, 12]] },
      { k: "dot", c: [10, 14.2], r: 0.85 },
    ],
  },

  // ------------------------------------------------------------------ layout
  /**
   * Panel family. One frame plus a divider; the "full" variant fills the minor
   * pane so the active state reads at a glance. Left-hand geometry only —
   * right/bottom variants rotate.
   */
  "layout-panel": {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 12, r: 2 },
      { k: "poly", pts: [[8, 4], [8, 16]] },
    ],
  },
  "layout-panel-full": {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 12, r: 2 },
      { k: "poly", pts: [[8, 4], [8, 16]] },
      { k: "rect", x: 3.9, y: 4.9, w: 3.2, h: 10.2, r: 1 },
    ],
  },
  /** Frame split into two equal panes — split view. */
  "split-view": {
    prims: [
      { k: "rect", x: 3, y: 4.5, w: 14, h: 11, r: 2 },
      { k: "poly", pts: [[10, 4.5], [10, 15.5]] },
    ],
  },
  /** Frame with a horizontal rule — unified view. */
  "unified-view": {
    prims: [
      { k: "rect", x: 3, y: 4.5, w: 14, h: 11, r: 2 },
      { k: "poly", pts: [[3, 10], [17, 10]] },
    ],
  },
  /** Corner brackets pulling apart — expand/maximize. */
  expand: {
    prims: [
      { k: "poly", pts: [[11.5, 4.5], [15.5, 4.5], [15.5, 8.5]] },
      { k: "poly", pts: [[8.5, 15.5], [4.5, 15.5], [4.5, 11.5]] },
      { k: "poly", pts: [[15.5, 4.5], [11, 9]] },
      { k: "poly", pts: [[4.5, 15.5], [9, 11]] },
    ],
  },
  /** Corner brackets pulling together — collapse/restore. */
  collapse: {
    prims: [
      { k: "poly", pts: [[15, 9], [11, 9], [11, 5]] },
      { k: "poly", pts: [[5, 11], [9, 11], [9, 15]] },
      { k: "poly", pts: [[11, 9], [15.5, 4.5]] },
      { k: "poly", pts: [[9, 11], [4.5, 15.5]] },
    ],
  },
  /** Chevrons fleeing a stack of rules — expand-all in a tree. */
  "expand-all": {
    prims: [
      { k: "poly", pts: [[3.5, 6], [6, 3.5], [8.5, 6]] },
      { k: "poly", pts: [[3.5, 14], [6, 16.5], [8.5, 14]] },
      { k: "poly", pts: [[11.5, 7], [16.5, 7]] },
      { k: "poly", pts: [[11.5, 10], [15, 10]] },
      { k: "poly", pts: [[11.5, 13], [16.5, 13]] },
    ],
  },
  "collapse-all": {
    prims: [
      { k: "poly", pts: [[3.5, 3.5], [6, 6], [8.5, 3.5]] },
      { k: "poly", pts: [[3.5, 16.5], [6, 14], [8.5, 16.5]] },
      { k: "poly", pts: [[11.5, 7], [16.5, 7]] },
      { k: "poly", pts: [[11.5, 10], [15, 10]] },
      { k: "poly", pts: [[11.5, 13], [16.5, 13]] },
    ],
  },

  // ------------------------------------------------------------------- files
  /** Sheet with a folded corner. */
  file: {
    prims: [
      { k: "poly", pts: [[5, 3], [12, 3], [16, 7], [16, 17], [5, 17]], close: true },
      { k: "poly", pts: [[11.5, 3.2], [11.5, 7.5], [15.8, 7.5]] },
    ],
  },
  "file-text": {
    prims: [
      { k: "poly", pts: [[5, 3], [12, 3], [16, 7], [16, 17], [5, 17]], close: true },
      { k: "poly", pts: [[11.5, 3.2], [11.5, 7.5], [15.8, 7.5]] },
      { k: "poly", pts: [[7.5, 10.5], [13, 10.5]] },
      { k: "poly", pts: [[7.5, 13.5], [13, 13.5]] },
    ],
  },
  "file-plus": {
    prims: [
      { k: "poly", pts: [[5, 3], [12, 3], [16, 7], [16, 17], [5, 17]], close: true },
      { k: "poly", pts: [[11.5, 3.2], [11.5, 7.5], [15.8, 7.5]] },
      { k: "poly", pts: [[10.5, 9.5], [10.5, 14.5]] },
      { k: "poly", pts: [[8, 12], [13, 12]] },
    ],
  },
  /** Closed folder: back panel, tab, front panel. */
  folder: {
    prims: [{ k: "poly", pts: [[3, 15.5], [3, 5], [8, 5], [10, 7.5], [17, 7.5], [17, 15.5]], close: true }],
  },
  /** Open folder: the front panel skews away from the back. */
  "folder-open": {
    prims: [
      { k: "poly", pts: [[3, 15.5], [3, 5], [8, 5], [10, 7.5], [15.5, 7.5], [15.5, 9.5]] },
      { k: "poly", pts: [[3, 15.5], [5.8, 9.5], [18, 9.5], [15.2, 15.5]], close: true },
    ],
  },
  "folder-plus": {
    prims: [
      { k: "poly", pts: [[3, 15.5], [3, 5], [8, 5], [10, 7.5], [17, 7.5], [17, 15.5]], close: true },
      { k: "poly", pts: [[10, 9.75], [10, 14]] },
      { k: "poly", pts: [[7.875, 11.875], [12.125, 11.875]] },
    ],
  },
  /** Two offset folders — a project group. */
  folders: {
    prims: [
      { k: "poly", pts: [[6, 4.5], [9.5, 4.5], [11, 6.5], [17, 6.5], [17, 13]] },
      { k: "poly", pts: [[3, 16], [3, 7.5], [7, 7.5], [8.5, 9.5], [15, 9.5], [15, 16]], close: true },
    ],
  },
  /** Tree: a spine with two branch stubs and leaf nodes. */
  "file-tree": {
    prims: [
      { k: "poly", pts: [[5.5, 4], [5.5, 14.5], [9, 14.5]] },
      { k: "poly", pts: [[5.5, 9.5], [9, 9.5]] },
      { k: "rect", x: 11, y: 3, w: 5.5, h: 3, r: 1 },
      { k: "rect", x: 11, y: 8, w: 5.5, h: 3, r: 1 },
      { k: "rect", x: 11, y: 13, w: 5.5, h: 3, r: 1 },
      { k: "poly", pts: [[5.5, 4.5], [11, 4.5]] },
    ],
  },
  /** Stacked rules — a plain list/menu. */
  list: {
    prims: [
      { k: "poly", pts: [[4, 6], [16, 6]] },
      { k: "poly", pts: [[4, 10], [16, 10]] },
      { k: "poly", pts: [[4, 14], [16, 14]] },
    ],
  },
  /** Rules with leading bullets — a checklist. */
  "bullet-list": {
    prims: [
      { k: "dot", c: [5, 6], r: 1.1 },
      { k: "dot", c: [5, 10], r: 1.1 },
      { k: "dot", c: [5, 14], r: 1.1 },
      { k: "poly", pts: [[8.5, 6], [16, 6]] },
      { k: "poly", pts: [[8.5, 10], [16, 10]] },
      { k: "poly", pts: [[8.5, 14], [16, 14]] },
    ],
  },
  checklist: {
    prims: [
      { k: "poly", pts: [[3.5, 6], [5, 7.5], [7.5, 4.5]] },
      { k: "poly", pts: [[3.5, 13], [5, 14.5], [7.5, 11.5]] },
      { k: "poly", pts: [[10, 6], [16.5, 6]] },
      { k: "poly", pts: [[10, 13], [16.5, 13]] },
    ],
  },
  archive: {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 3.5, r: 1 },
      { k: "poly", pts: [[4.5, 7.5], [4.5, 16], [15.5, 16], [15.5, 7.5]] },
      { k: "poly", pts: [[8.25, 11], [11.75, 11]] },
    ],
  },
  trash: {
    prims: [
      { k: "poly", pts: [[3.5, 5.5], [16.5, 5.5]] },
      { k: "poly", pts: [[8, 5.5], [8, 3.5], [12, 3.5], [12, 5.5]] },
      { k: "poly", pts: [[5, 5.5], [5.9, 16.5], [14.1, 16.5], [15, 5.5]] },
      { k: "poly", pts: [[8.5, 8.5], [8.5, 13.5]] },
      { k: "poly", pts: [[11.5, 8.5], [11.5, 13.5]] },
    ],
  },
  copy: {
    prims: [
      { k: "rect", x: 7, y: 7, w: 9, h: 9, r: 2 },
      { k: "poly", pts: [[13, 4], [6, 4], [4, 6], [4, 13]] },
    ],
  },
  photo: {
    prims: [
      { k: "rect", x: 3, y: 4.5, w: 14, h: 11, r: 2 },
      { k: "circle", c: [7.5, 8.5], r: 1.4 },
      { k: "poly", pts: [[3.5, 14], [8, 9.5], [13, 14.5]] },
      { k: "poly", pts: [[11.5, 13], [14, 10.5], [16.5, 13]] },
    ],
  },

  // ------------------------------------------------------------------ tools
  /** Circle plus a tangent handle on the SE diagonal. */
  search: {
    prims: [
      { k: "circle", c: [9, 9], r: 5.25 },
      { k: "poly", pts: [[12.9, 12.9], [16.5, 16.5]] },
    ],
  },
  /** Search with leading rules — filter within a list. */
  "search-menu": {
    prims: [
      { k: "poly", pts: [[2.5, 5.5], [6, 5.5]] },
      { k: "poly", pts: [[2.5, 10], [5, 10]] },
      { k: "poly", pts: [[2.5, 14.5], [6, 14.5]] },
      { k: "circle", c: [12, 10], r: 5 },
      { k: "poly", pts: [[15.7, 13.7], [18, 16]] },
    ],
  },
  /** Nib tracking a diagonal — edit. */
  pencil: {
    prims: [
      { k: "poly", pts: [[4, 16], [4.9, 12.6], [13.4, 4.1], [15.9, 6.6], [7.4, 15.1]], close: true },
      { k: "poly", pts: [[11.9, 5.6], [14.4, 8.1]] },
    ],
  },
  /** Pencil above a baseline — rename in place. */
  "pencil-line": {
    prims: [
      { k: "poly", pts: [[4, 12.5], [4.7, 9.8], [11.8, 2.7], [13.8, 4.7], [6.7, 11.8]], close: true },
      { k: "poly", pts: [[4, 17], [16.5, 17]] },
    ],
  },
  /**
   * Toothed ring — settings.
   *
   * The teeth have to BE the outer contour. Spokes radiating from a plain
   * circle read as an asterisk or a sun, not a gear, because the eye needs the
   * silhouette itself to alternate. So the outline walks tip-tip-valley-valley
   * around seven teeth, and corner rounding softens the tooth shoulders.
   */
  gear: {
    prims: [
      {
        k: "poly",
        pts: gearRing(7, 8.1, 5.6, 0.2),
        close: true,
      },
      { k: "circle", c: [10, 10], r: 2.5 },
    ],
  },
  /** Three tracks with offset handles. */
  sliders: {
    prims: [
      { k: "poly", pts: [[3.5, 6], [16.5, 6]] },
      { k: "poly", pts: [[3.5, 10], [16.5, 10]] },
      { k: "poly", pts: [[3.5, 14], [16.5, 14]] },
      { k: "circle", c: [7, 6], r: 1.75 },
      { k: "circle", c: [13, 10], r: 1.75 },
      { k: "circle", c: [8.5, 14], r: 1.75 },
    ],
  },
  /** Prompt caret above a command line. */
  terminal: {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 12, r: 2 },
      { k: "poly", pts: [[6.5, 8], [9, 10.5], [6.5, 13]] },
      { k: "poly", pts: [[11, 13], [14, 13]] },
    ],
  },
  /** Angle brackets — code. */
  code: {
    prims: [
      { k: "poly", pts: [[7, 6.5], [3, 10], [7, 13.5]] },
      { k: "poly", pts: [[13, 6.5], [17, 10], [13, 13.5]] },
    ],
  },
  /** Brackets around stacked rules — a code block. */
  "code-lines": {
    prims: [
      { k: "poly", pts: [[6.5, 5], [3.5, 10], [6.5, 15]] },
      { k: "poly", pts: [[13.5, 5], [16.5, 10], [13.5, 15]] },
      { k: "poly", pts: [[11.5, 6], [8.5, 14]] },
    ],
  },
  keyboard: {
    prims: [
      { k: "rect", x: 2.5, y: 5.5, w: 15, h: 9, r: 2 },
      { k: "dot", c: [6, 8.75], r: 0.7 },
      { k: "dot", c: [9, 8.75], r: 0.7 },
      { k: "dot", c: [12, 8.75], r: 0.7 },
      { k: "dot", c: [14.5, 8.75], r: 0.7 },
      { k: "poly", pts: [[6.5, 11.75], [13.5, 11.75]] },
    ],
  },
  laptop: {
    prims: [
      { k: "poly", pts: [[4, 13.5], [4, 5.5], [16, 5.5], [16, 13.5]] },
      { k: "poly", pts: [[2, 15.5], [18, 15.5]] },
    ],
  },
  monitor: {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 10, r: 2 },
      { k: "poly", pts: [[10, 14], [10, 16.5]] },
      { k: "poly", pts: [[6.5, 16.5], [13.5, 16.5]] },
    ],
  },
  /** Stacked drives — a server or host. */
  server: {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 5, r: 1.5 },
      { k: "rect", x: 3, y: 11, w: 14, h: 5, r: 1.5 },
      { k: "dot", c: [6, 6.5], r: 0.85 },
      { k: "dot", c: [6, 13.5], r: 0.85 },
    ],
  },
  /** Dial with a needle — usage and limits. */
  gauge: {
    prims: [
      { k: "arc", c: [10, 11.5], r: 6.5, from: 180, to: 360 },
      { k: "poly", pts: [[10, 11.5], [13.2, 8.3]] },
      { k: "dot", c: [10, 11.5], r: 1.25 },
    ],
  },
  /** Padlock body with a shackle. */
  shield: {
    prims: [
      { k: "poly", pts: [[10, 3], [16, 5.5], [16, 10], [10, 17], [4, 10], [4, 5.5]], close: true },
      { k: "poly", pts: [[7.25, 9.75], [9.25, 11.75], [12.75, 8.25]] },
    ],
  },
  eye: {
    prims: [
      { k: "poly", pts: [[2.5, 10], [6, 5.75], [14, 5.75], [17.5, 10], [14, 14.25], [6, 14.25]], close: true },
      { k: "circle", c: [10, 10], r: 2.5 },
    ],
  },
  globe: {
    prims: [
      { k: "circle", c: [10, 10], r: 6.75 },
      { k: "poly", pts: [[3.25, 10], [16.75, 10]] },
      { k: "arc", c: [10, 10], r: 6.75, from: 270, to: 90 },
      { k: "poly", pts: [[10, 3.25], [10, 16.75]] },
    ],
  },
  cloud: {
    prims: [
      {
        k: "poly",
        pts: [[6.5, 15], [6.5, 15], [5, 14.6], [3.5, 12.6], [4.1, 10.1], [6.3, 8.9], [7.6, 6.3], [10.6, 5.2], [13.6, 6.3], [14.9, 8.9], [16.5, 10.6], [16.2, 13.3], [14, 15]],
        close: true,
      },
    ],
  },
  "cloud-upload": {
    prims: [
      { k: "poly", pts: [[7, 14.5], [5.4, 14.1], [4, 12.2], [4.6, 9.9], [6.6, 8.8], [7.8, 6.4], [10.6, 5.4], [13.4, 6.4], [14.6, 8.8], [16.1, 10.3], [15.8, 12.8], [13.8, 14.5]] },
      { k: "poly", pts: [[10, 16.5], [10, 10.5]] },
      { k: "poly", pts: [[7.75, 12.75], [10, 10.5], [12.25, 12.75]] },
    ],
  },
  link: {
    prims: [
      { k: "poly", pts: [[8.5, 11.5], [11.5, 8.5]] },
      { k: "poly", pts: [[7.75, 7.75], [6.25, 6.25], [3.75, 8.75], [3.75, 8.75]] },
      { k: "arc", c: [6.5, 13.5], r: 3.9, from: 135, to: 405 },
      { k: "arc", c: [13.5, 6.5], r: 3.9, from: -45, to: 225 },
    ],
  },
  /** Speech bubble with a tail. */
  speech: {
    prims: [{ k: "poly", pts: [[4, 4], [16, 4], [16, 13], [9.5, 13], [6, 16.5], [6, 13], [4, 13]], close: true }],
  },
  /** Head silhouette with a circuit trace — model/reasoning. */
  brain: {
    prims: [
      { k: "poly", pts: [[10, 4], [13.5, 5], [15.5, 8], [15, 11.5], [12.5, 13.5], [12.5, 16], [7.5, 16], [7.5, 13.5], [5, 11.5], [4.5, 8], [6.5, 5]], close: true },
      { k: "poly", pts: [[10, 5.5], [10, 13.5]] },
    ],
  },
  /** Open palm — the manual-approval mode. */
  hand: {
    prims: [
      { k: "poly", pts: [[6.5, 11], [6.5, 5.5]] },
      { k: "poly", pts: [[9.5, 10], [9.5, 4]] },
      { k: "poly", pts: [[12.5, 10.5], [12.5, 5]] },
      { k: "poly", pts: [[15.5, 12], [15.5, 8]] },
      { k: "poly", pts: [[6.5, 11], [4.5, 12.5], [7.5, 16.5], [13, 16.5], [15.5, 12]] },
    ],
  },
  /** Spectacles — review. */
  glasses: {
    prims: [
      { k: "circle", c: [6, 12], r: 3.25 },
      { k: "circle", c: [14, 12], r: 3.25 },
      { k: "poly", pts: [[9.25, 12], [10.75, 12]] },
      { k: "poly", pts: [[2.75, 12], [4, 6.5]] },
      { k: "poly", pts: [[17.25, 12], [16, 6.5]] },
    ],
  },
  /** Cursor arrow inside a window frame. */
  "window-cursor": {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 12, r: 2 },
      { k: "poly", pts: [[3, 7.5], [17, 7.5]] },
      { k: "poly", pts: [[8, 10], [13.5, 12.4], [11.1, 13.1], [10.4, 15.5]], close: true },
    ],
  },
  /** Pin body with a shaft. */
  pin: {
    prims: [
      { k: "poly", pts: [[6.75, 10.5], [13.25, 10.5]] },
      { k: "poly", pts: [[8.5, 10.5], [8.5, 5], [11.5, 5], [11.5, 10.5]] },
      { k: "poly", pts: [[10, 10.5], [10, 16.5]] },
    ],
  },
  "pin-filled": {
    prims: [
      { k: "poly", pts: [[8.5, 4.5], [11.5, 4.5], [11.5, 10.5], [13.5, 10.5], [13.5, 12], [6.5, 12], [6.5, 10.5], [8.5, 10.5]], close: true },
      { k: "poly", pts: [[10, 12], [10, 16.5]] },
    ],
    filled: true,
  },
  /** Upload/send: shaft with a head at the top. */
  send: {
    prims: [
      { k: "poly", pts: [[10, 16], [10, 4.5]] },
      { k: "poly", pts: [[5.5, 9], [10, 4.5], [14.5, 9]] },
    ],
  },
  /** Two panes with a hinge — workspace/project. */
  workspace: {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 12, r: 2 },
      { k: "poly", pts: [[3, 8], [17, 8]] },
      { k: "poly", pts: [[8, 8], [8, 16]] },
    ],
  },
  /** Workspace with a boundary marker — isolated/sandboxed. */
  "workspace-isolated": {
    prims: [
      { k: "rect", x: 3, y: 4, w: 14, h: 12, r: 2 },
      { k: "poly", pts: [[3, 8], [17, 8]] },
      { k: "poly", pts: [[10, 11], [10, 13.5]] },
      { k: "dot", c: [10, 10], r: 0.8 },
    ],
  },
  /** Node graph — the workgraph mark. */
  graph: {
    prims: [
      { k: "circle", c: [5.5, 6], r: 2.25 },
      { k: "circle", c: [14.5, 6], r: 2.25 },
      { k: "circle", c: [10, 15], r: 2.25 },
      { k: "poly", pts: [[7.75, 6], [12.25, 6]] },
      { k: "poly", pts: [[6.6, 8], [8.9, 12.9]] },
      { k: "poly", pts: [[13.4, 8], [11.1, 12.9]] },
    ],
  },
  /** Stacked planes — extensions and providers. */
  layers: {
    prims: [
      { k: "poly", pts: [[10, 3.5], [17, 7], [10, 10.5], [3, 7]], close: true },
      { k: "poly", pts: [[3, 11], [10, 14.5], [17, 11]] },
    ],
  },
  /** Two agents — subagent/delegation. */
  subagent: {
    prims: [
      { k: "circle", c: [7.5, 7], r: 2.75 },
      { k: "poly", pts: [[3, 16], [3.6, 13.2], [6, 11.75], [9, 11.75], [11.4, 13.2], [12, 16]] },
      { k: "arc", c: [14, 8], r: 2.25, from: -90, to: 90 },
      { k: "poly", pts: [[14, 11.5], [15.8, 12.4], [17, 15]] },
    ],
  },
} as const satisfies Record<string, Glyph>

export type ShapeName = keyof typeof SHAPES
