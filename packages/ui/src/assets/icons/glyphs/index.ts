import { GLYPH_STYLES, renderGlyph, type GlyphStyle, type GlyphStyleName } from "./geometry"
import { SHAPES, type ShapeName } from "./shapes"

export { GLYPH_STYLES, renderGlyph, primitivePath } from "./geometry"
export type { Glyph, GlyphStyle, GlyphStyleName, Primitive, Point } from "./geometry"
export { SHAPES } from "./shapes"
export type { ShapeName } from "./shapes"

/**
 * Rotation applied to a shape to reach a catalog name, in degrees clockwise
 * about the canvas centre.
 *
 * SVG's positive rotation is clockwise under a y-down axis, so `rotate(90)`
 * sends east to south and west to north. Directional families are therefore
 * authored once in their east/left canonical orientation and rotated here.
 */
export type IconBinding = { shape: ShapeName; rotate?: 90 | 180 | 270 }

/**
 * Names whose artwork is a wordmark or logo. Geometry cannot be authored for
 * these from first principles — they are specific marks, and the point of a
 * logo is that it is not derivable. They stay outside the parametric system and
 * keep their existing dedicated artwork.
 */
export const BRAND_ICONS = ["claude", "cursor", "discord", "github", "openai", "opencode", "pi"] as const
export type BrandIconName = (typeof BRAND_ICONS)[number]

/** Catalog name to shape, for every non-brand icon in the app catalog. */
export const ICON_BINDINGS = {
  "align-right": { shape: "arrow" },
  "arrow-down-to-line": { shape: "arrow-to-line" },
  "arrow-left": { shape: "arrow", rotate: 180 },
  "arrow-right": { shape: "arrow" },
  "arrow-undo-down": { shape: "arrow-undo" },
  "arrow-up": { shape: "arrow", rotate: 270 },
  archive: { shape: "archive" },
  brain: { shape: "brain" },
  branch: { shape: "branch" },
  "bubble-5": { shape: "speech" },
  "bullet-list": { shape: "bullet-list" },
  check: { shape: "check" },
  "check-small": { shape: "check-small" },
  checklist: { shape: "checklist" },
  "chevron-double-left": { shape: "chevron-double", rotate: 180 },
  "chevron-double-right": { shape: "chevron-double" },
  "chevron-down": { shape: "chevron", rotate: 90 },
  "chevron-grabber-vertical": { shape: "chevron-grabber" },
  "chevron-left": { shape: "chevron", rotate: 180 },
  "chevron-right": { shape: "chevron" },
  circle: { shape: "circle" },
  "circle-alert": { shape: "circle-alert" },
  "circle-ban-sign": { shape: "circle-ban" },
  "circle-check": { shape: "circle-check" },
  "circle-dashed": { shape: "circle-dashed" },
  "circle-half": { shape: "circle-half" },
  "circle-x": { shape: "circle-x" },
  close: { shape: "xmark" },
  "close-small": { shape: "xmark-small" },
  cloud: { shape: "cloud" },
  "cloud-upload": { shape: "cloud-upload" },
  code: { shape: "code" },
  "code-lines": { shape: "code-lines" },
  collapse: { shape: "collapse" },
  "collapse-all": { shape: "collapse-all" },
  comment: { shape: "speech" },
  console: { shape: "terminal" },
  copy: { shape: "copy" },
  changes: { shape: "unified-view" },
  dash: { shape: "dash" },
  download: { shape: "arrow-to-line" },
  "dot-grid": { shape: "dot-grid" },
  edit: { shape: "pencil" },
  "edit-small-2": { shape: "pencil" },
  enter: { shape: "enter" },
  expand: { shape: "expand" },
  "expand-all": { shape: "expand-all" },
  eye: { shape: "eye" },
  file: { shape: "file" },
  "file-text": { shape: "file-text" },
  "file-tree": { shape: "file-tree" },
  "file-tree-active": { shape: "file-tree" },
  filetree: { shape: "file-tree" },
  folder: { shape: "folder" },
  "folder-add-left": { shape: "folder-plus" },
  "folder-open": { shape: "folder-open" },
  folders: { shape: "folders" },
  fork: { shape: "fork" },
  gauge: { shape: "gauge" },
  glasses: { shape: "glasses" },
  globe: { shape: "globe" },
  "grid-plus": { shape: "file-plus" },
  hand: { shape: "hand" },
  help: { shape: "help" },
  kebab: { shape: "kebab" },
  keyboard: { shape: "keyboard" },
  laptop: { shape: "laptop" },
  "layout-bottom": { shape: "layout-panel", rotate: 270 },
  "layout-bottom-full": { shape: "layout-panel-full", rotate: 270 },
  "layout-bottom-partial": { shape: "layout-panel", rotate: 270 },
  "layout-left": { shape: "layout-panel" },
  "layout-left-full": { shape: "layout-panel-full" },
  "layout-left-partial": { shape: "layout-panel" },
  "layout-right": { shape: "layout-panel", rotate: 180 },
  "layout-right-full": { shape: "layout-panel-full", rotate: 180 },
  "layout-right-partial": { shape: "layout-panel", rotate: 180 },
  link: { shape: "link" },
  magnifying: { shape: "search" },
  "magnifying-glass": { shape: "search" },
  "magnifying-glass-menu": { shape: "search-menu" },
  marketplace: { shape: "layers" },
  maximize: { shape: "expand" },
  mcp: { shape: "link" },
  menu: { shape: "list" },
  models: { shape: "layers" },
  monitor: { shape: "monitor" },
  "more-horizontal": { shape: "more-horizontal" },
  "new-session": { shape: "pencil" },
  "new-session-active": { shape: "pencil" },
  "open-file": { shape: "file" },
  "outline-chevron-down": { shape: "chevron", rotate: 90 },
  "outline-copy": { shape: "copy" },
  "outline-dots": { shape: "more-horizontal" },
  "outline-reset": { shape: "arrow-undo" },
  "outline-share": { shape: "square-arrow" },
  "outline-sliders": { shape: "sliders" },
  "outline-square-arrow": { shape: "square-arrow" },
  "outline-xmark": { shape: "xmark" },
  page: { shape: "file-text" },
  "page-plus": { shape: "file-plus" },
  pencil: { shape: "pencil" },
  "pencil-line": { shape: "pencil-line" },
  photo: { shape: "photo" },
  pin: { shape: "pin" },
  "pin-filled": { shape: "pin-filled" },
  play: { shape: "play" },
  plus: { shape: "plus" },
  "plus-small": { shape: "plus-small" },
  process: { shape: "server" },
  "process-command": { shape: "terminal" },
  "process-cwd": { shape: "folder" },
  "process-name": { shape: "server" },
  prompt: { shape: "speech" },
  providers: { shape: "layers" },
  reload: { shape: "arrow-undo" },
  reset: { shape: "arrow-undo" },
  review: { shape: "glasses" },
  "review-active": { shape: "glasses" },
  "scroll-to-latest": { shape: "arrow-to-line" },
  server: { shape: "server" },
  send: { shape: "send" },
  selector: { shape: "chevron-grabber" },
  settings: { shape: "gear" },
  "settings-gear": { shape: "gear" },
  share: { shape: "square-arrow" },
  shield: { shape: "shield" },
  sidebar: { shape: "layout-panel" },
  "sidebar-active": { shape: "layout-panel-full" },
  "sidebar-right": { shape: "layout-panel", rotate: 180 },
  sliders: { shape: "sliders" },
  speech: { shape: "speech" },
  "speech-bubble": { shape: "speech" },
  split: { shape: "split-view" },
  "square-arrow-top-right": { shape: "square-arrow" },
  status: { shape: "circle" },
  "status-active": { shape: "dot" },
  stop: { shape: "stop" },
  subagent: { shape: "subagent" },
  task: { shape: "checklist" },
  terminal: { shape: "terminal" },
  "terminal-active": { shape: "terminal" },
  "terminal-square": { shape: "terminal" },
  trash: { shape: "trash" },
  unified: { shape: "unified-view" },
  warning: { shape: "warning" },
  "window-cursor": { shape: "window-cursor" },
  workgraph: { shape: "graph" },
  workspace: { shape: "workspace" },
  "workspace-isolated": { shape: "workspace-isolated" },
  "workspace-new": { shape: "workspace" },
  worktree: { shape: "fork" },
  "xmark-small": { shape: "xmark-small" },
} as const satisfies Record<string, IconBinding>

export type GlyphIconName = keyof typeof ICON_BINDINGS

export const glyphIconNames = Object.freeze(Object.keys(ICON_BINDINGS) as GlyphIconName[])

export function resolveStyle(style: GlyphStyleName | GlyphStyle): GlyphStyle {
  return typeof style === "string" ? GLYPH_STYLES[style] : style
}

export type RenderedIcon = {
  stroke: string
  fill: string
  transform?: string
  attributes: { "stroke-width": string; "stroke-linecap": string; "stroke-linejoin": string }
}

/** Render one catalog icon under a style. */
export function renderIcon(name: GlyphIconName, style: GlyphStyleName | GlyphStyle): RenderedIcon {
  const binding = ICON_BINDINGS[name] as IconBinding
  const rendered = renderGlyph(SHAPES[binding.shape], resolveStyle(style))
  return {
    ...rendered,
    ...(binding.rotate ? { transform: `rotate(${binding.rotate} 10 10)` } : {}),
  }
}

/** `<symbol>` markup for one icon, for sprite assembly. */
export function iconSymbol(name: GlyphIconName, style: GlyphStyleName | GlyphStyle, idPrefix = "glyph") {
  const icon = renderIcon(name, style)
  const attrs = [
    `fill="none"`,
    `stroke-width="${icon.attributes["stroke-width"]}"`,
    `stroke-linecap="${icon.attributes["stroke-linecap"]}"`,
    `stroke-linejoin="${icon.attributes["stroke-linejoin"]}"`,
  ].join(" ")
  const body = [
    icon.stroke ? `<path d="${icon.stroke}" stroke="currentColor"/>` : "",
    icon.fill ? `<path d="${icon.fill}" fill="currentColor" stroke="none"/>` : "",
  ].join("")
  const group = icon.transform ? `<g transform="${icon.transform}">${body}</g>` : body
  return `<symbol id="${idPrefix}-${name}" viewBox="0 0 20 20" ${attrs}>${group}</symbol>`
}

/** The full sprite for a style, as a single `<svg>` string. */
export function renderIconSprite(style: GlyphStyleName | GlyphStyle, idPrefix = "glyph") {
  const symbols = glyphIconNames.map((name) => iconSymbol(name, style, idPrefix)).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute;overflow:hidden">${symbols}</svg>`
}
