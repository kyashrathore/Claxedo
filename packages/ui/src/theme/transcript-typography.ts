import { isKeyOf } from "../utils/record"
import { isRecord } from "@claxedo/helpers/guards"

/**
 * A face with no `stack` follows the app-level font token of its kind
 * (`--font-family-sans` for the UI-font setting, `--font-family-mono` for the
 * code-font setting) instead of naming a family. Every named stack ends in a
 * generic family so a platform without the face still renders.
 */
export const TRANSCRIPT_FACES = {
  system: { label: "System", kind: "sans" },
  sfdisplay: { label: "SF Pro Display", kind: "sans", stack: `"SF Pro Display", ui-sans-serif, system-ui, sans-serif` },
  avenir: { label: "Avenir Next", kind: "sans", stack: `"Avenir Next", Avenir, system-ui, sans-serif` },
  seravek: { label: "Seravek", kind: "sans", stack: `Seravek, "Avenir Next", system-ui, sans-serif` },
  optima: { label: "Optima", kind: "sans", stack: `Optima, "Gill Sans", system-ui, sans-serif` },
  gill: { label: "Gill Sans", kind: "sans", stack: `"Gill Sans", "Gill Sans MT", Optima, sans-serif` },
  helvetica: { label: "Helvetica Neue", kind: "sans", stack: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  ptsans: { label: "PT Sans", kind: "sans", stack: `"PT Sans", system-ui, sans-serif` },
  verdana: { label: "Verdana", kind: "sans", stack: `Verdana, Geneva, sans-serif` },
  newyork: { label: "New York", kind: "serif", stack: `ui-serif, "New York", Charter, Georgia, serif` },
  charter: { label: "Charter", kind: "serif", stack: `Charter, "Bitstream Charter", Georgia, serif` },
  iowan: { label: "Iowan Old Style", kind: "serif", stack: `"Iowan Old Style", Charter, Georgia, serif` },
  athelas: { label: "Athelas", kind: "serif", stack: `Athelas, Charter, Georgia, serif` },
  palatino: { label: "Palatino", kind: "serif", stack: `Palatino, "Palatino Linotype", "Book Antiqua", serif` },
  hoefler: { label: "Hoefler Text", kind: "serif", stack: `"Hoefler Text", Charter, Georgia, serif` },
  baskerville: { label: "Baskerville", kind: "serif", stack: `Baskerville, "Times New Roman", serif` },
  clarendon: { label: "SuperClarendon", kind: "serif", stack: `SuperClarendon, Charter, Georgia, serif` },
  georgia: { label: "Georgia", kind: "serif", stack: `Georgia, Charter, serif` },
  ptserif: { label: "PT Serif", kind: "serif", stack: `"PT Serif", Charter, Georgia, serif` },
  sfmono: { label: "System Mono", kind: "mono" },
  menlo: { label: "Menlo", kind: "mono", stack: `Menlo, Monaco, ui-monospace, monospace` },
  ptmono: { label: "PT Mono", kind: "mono", stack: `"PT Mono", Menlo, ui-monospace, monospace` },
  typewriter: { label: "American Typewriter", kind: "mono", stack: `"American Typewriter", Courier, monospace` },
} as const satisfies Record<string, { label: string; kind: "sans" | "serif" | "mono"; stack?: string }>

export type TranscriptFace = keyof typeof TRANSCRIPT_FACES
export type TranscriptFaceKind = (typeof TRANSCRIPT_FACES)[TranscriptFace]["kind"]

export const isTranscriptFace = (value: unknown): value is TranscriptFace =>
  typeof value === "string" && isKeyOf(TRANSCRIPT_FACES, value)

export const transcriptFacesOfKind = (kind: TranscriptFaceKind): TranscriptFace[] =>
  Object.keys(TRANSCRIPT_FACES)
    .filter(isTranscriptFace)
    .filter((key) => TRANSCRIPT_FACES[key].kind === kind)

/** px, weight 400–800, line-height 1.25, margins in px, tracking in em. */
export const TRANSCRIPT_HEADING_SCALES = {
  flat: undefined,
  subtle: [
    { size: 17, weight: 600, top: 28, bottom: 10, tracking: 0 },
    { size: 15, weight: 600, top: 24, bottom: 8, tracking: 0 },
    { size: 14, weight: 600, top: 20, bottom: 6, tracking: 0 },
    { size: 14, weight: 600, top: 20, bottom: 6, tracking: 0 },
  ],
  clear: [
    { size: 21, weight: 600, top: 34, bottom: 12, tracking: 0 },
    { size: 17, weight: 600, top: 28, bottom: 10, tracking: 0 },
    { size: 15, weight: 600, top: 22, bottom: 6, tracking: 0 },
    { size: 14, weight: 600, top: 20, bottom: 6, tracking: 0 },
  ],
  editorial: [
    { size: 25, weight: 620, top: 40, bottom: 14, tracking: -0.02 },
    { size: 19, weight: 600, top: 32, bottom: 10, tracking: -0.012 },
    { size: 15, weight: 640, top: 24, bottom: 6, tracking: 0.01 },
    { size: 15, weight: 640, top: 20, bottom: 6, tracking: 0.01 },
  ],
  /**
   * Cursor's conversation headings: `.composer-message-markdown h1, h2 {1.214em}`,
   * h3 and below 1.133em (Markdown.stylex level3), weight
   * `--cursor-font-weight-semibold` 590, margin-top `calc(14px * 22 / 15)`,
   * margin-bottom `--cursor-spacing-1`.
   */
  cursor: [
    { size: 17, weight: 590, top: 20.5, bottom: 4, tracking: 0 },
    { size: 17, weight: 590, top: 20.5, bottom: 4, tracking: 0 },
    { size: 16, weight: 590, top: 20.5, bottom: 4, tracking: 0 },
    { size: 16, weight: 590, top: 20.5, bottom: 4, tracking: 0 },
  ],
  /**
   * Codex's `_Heading`: h1 1.5×, h2 1.25×, h3 1.125×, h4 1× of the 14px chat
   * size, semibold; h1 has no top margin, the rest sit `4 * --markdown-space`
   * (14px) below the previous block and `--markdown-space` (3.5px) above the next.
   */
  codex: [
    { size: 21, weight: 600, top: 0, bottom: 7, tracking: 0 },
    { size: 17.5, weight: 600, top: 14, bottom: 3.5, tracking: 0 },
    { size: 15.75, weight: 600, top: 14, bottom: 3.5, tracking: 0 },
    { size: 14, weight: 600, top: 14, bottom: 3.5, tracking: 0 },
  ],
} as const satisfies Record<
  string,
  readonly [HeadingLevel, HeadingLevel, HeadingLevel, HeadingLevel] | undefined
>

type HeadingLevel = { size: number; weight: number; top: number; bottom: number; tracking: number }

export type TranscriptHeadingScale = keyof typeof TRANSCRIPT_HEADING_SCALES

export const isTranscriptHeadingScale = (value: unknown): value is TranscriptHeadingScale =>
  typeof value === "string" && isKeyOf(TRANSCRIPT_HEADING_SCALES, value)

export const TRANSCRIPT_HEADING_SCALE_KEYS: readonly TranscriptHeadingScale[] = Object.keys(
  TRANSCRIPT_HEADING_SCALES,
).filter(isTranscriptHeadingScale)

/**
 * Every number the transcript is set with, as the `--transcript-<css>` variable
 * the stylesheets read (`markdown.css`, `message-part.css`, `basic-tool.css`,
 * `activity-row.css`, `work-group.css`, `session-turn.css`) and the value those
 * stylesheets fall back to when the variable is absent. A `shipped` of
 * `undefined` marks a knob whose fallback differs per element (block margins,
 * the responsive column, a code block's inherited leading, a group's indent),
 * so it is only ever written when a pairing or override names it. Units: px
 * unless noted; `ratio` is a unitless line-height; `weight` a font weight.
 */
export const TRANSCRIPT_NUMBERS = {
  fontSize: { css: "font-size", unit: "px", shipped: 14, min: 11, max: 20 },
  lineHeight: { css: "line-height", unit: "ratio", shipped: 1.6, min: 1.2, max: 2 },
  tracking: { css: "letter-spacing", unit: "px", shipped: 0, min: -0.5, max: 0.3 },
  bodyWeight: { css: "body-weight", unit: "weight", shipped: 400, min: 300, max: 600 },
  boldWeight: { css: "bold-weight", unit: "weight", shipped: 600, min: 400, max: 800 },
  paragraphGap: { css: "paragraph-gap", unit: "px", shipped: 6, min: 0, max: 32 },
  blockGap: { css: "block-gap", unit: "px", shipped: undefined, min: 0, max: 32 },
  listGap: { css: "list-gap", unit: "px", shipped: 8, min: 0, max: 16 },
  listIndent: { css: "list-indent", unit: "px", shipped: 32, min: 12, max: 48 },
  nestedListIndent: { css: "nested-list-indent", unit: "px", shipped: 16, min: 8, max: 40 },
  quoteIndent: { css: "quote-indent", unit: "px", shipped: 8, min: 0, max: 24 },
  quoteBorder: { css: "quote-border", unit: "px", shipped: 2, min: 0, max: 4 },
  measure: { css: "measure", unit: "ch", shipped: undefined, min: 48, max: 110 },
  inlineCodeSize: { css: "inline-code-size", unit: "em", shipped: 0.8, min: 0.7, max: 1 },
  codeFontSize: { css: "code-font-size", unit: "px", shipped: 13, min: 10, max: 16 },
  codePadding: { css: "code-padding", unit: "px", shipped: 12, min: 0, max: 24 },
  codeLineHeight: { css: "code-line-height", unit: "ratio", shipped: undefined, min: 1.1, max: 2 },
  tableCellPadding: { css: "table-cell-padding", unit: "px", shipped: 12, min: 2, max: 20 },
  tableHeadWeight: { css: "table-head-weight", unit: "weight", shipped: 500, min: 400, max: 800 },
  toolSize: { css: "tool-size", unit: "px", shipped: 14, min: 10, max: 18 },
  toolLineHeight: { css: "tool-line-height", unit: "ratio", shipped: 1.5, min: 1.1, max: 2 },
  toolWeight: { css: "tool-weight", unit: "weight", shipped: 500, min: 300, max: 700 },
  toolRowHeight: { css: "tool-row-height", unit: "px", shipped: 32, min: 20, max: 48 },
  toolGap: { css: "tool-gap", unit: "px", shipped: 8, min: 0, max: 16 },
  toolIconSize: { css: "tool-icon-size", unit: "px", shipped: 14, min: 10, max: 20 },
  groupIndent: { css: "group-indent", unit: "px", shipped: undefined, min: 0, max: 32 },
  groupGap: { css: "group-gap", unit: "px", shipped: 4, min: 0, max: 16 },
  groupCap: { css: "group-cap", unit: "px", shipped: 224, min: 96, max: 640 },
  outputLineHeight: { css: "output-line-height", unit: "ratio", shipped: 1.5, min: 1.1, max: 2 },
  outputPadding: { css: "output-padding", unit: "px", shipped: 12, min: 0, max: 24 },
  outputCap: { css: "output-cap", unit: "px", shipped: 240, min: 96, max: 960 },
  cardPaddingY: { css: "card-padding-y", unit: "px", shipped: 8, min: 0, max: 24 },
  cardPaddingX: { css: "card-padding-x", unit: "px", shipped: 10, min: 0, max: 24 },
  cardGap: { css: "card-gap", unit: "px", shipped: 24, min: 0, max: 40 },
  compactSize: { css: "compact-size", unit: "px", shipped: 13, min: 10, max: 16 },
  reasoningLineHeight: { css: "reasoning-line-height", unit: "ratio", shipped: 1.3, min: 1.1, max: 2 },
  metaSize: { css: "meta-size", unit: "px", shipped: 12, min: 9, max: 14 },
  metaLineHeight: { css: "meta-line-height", unit: "ratio", shipped: 1.5, min: 1.1, max: 2 },
  turnGap: { css: "turn-gap", unit: "px", shipped: 24, min: 0, max: 64 },
  partGap: { css: "part-gap", unit: "px", shipped: 12, min: 0, max: 32 },
  textPartTop: { css: "text-part-top", unit: "px", shipped: 24, min: 0, max: 48 },
  scrollbarSize: { css: "scrollbar-size", unit: "px", shipped: 8, min: 4, max: 14 },
} as const satisfies Record<string, NumberKnob>

type NumberKnob = { css: string; unit: "px" | "em" | "ch" | "ratio" | "weight"; shipped: number | undefined; min: number; max: number }
export type TranscriptNumberKey = keyof typeof TRANSCRIPT_NUMBERS
const isTranscriptNumberKey = (value: string): value is TranscriptNumberKey => isKeyOf(TRANSCRIPT_NUMBERS, value)
export const TRANSCRIPT_NUMBER_KEYS: readonly TranscriptNumberKey[] = Object.keys(TRANSCRIPT_NUMBERS).filter(isTranscriptNumberKey)

/**
 * The colours the transcript's chrome is set in, each as a theme token by
 * default so a theme's palette still drives them; a pairing or theme may name
 * another token or a hex. Prose colour is the `proseColor` choice, not a knob.
 */
export const TRANSCRIPT_COLORS = {
  toolColor: { css: "tool-color", shipped: "var(--text-weak)" },
  toolHoverColor: { css: "tool-hover-color", shipped: "var(--text-strong)" },
  markerColor: { css: "marker-color", shipped: "var(--text-weak)" },
  linkColor: { css: "link-color", shipped: "var(--text-interactive-base)" },
  reasoningColor: { css: "reasoning-color", shipped: "var(--text-weak)" },
  metaColor: { css: "meta-color", shipped: "var(--text-weak)" },
  scrollbarThumb: { css: "scrollbar-thumb", shipped: "var(--text-weaker)" },
} as const satisfies Record<string, { css: string; shipped: TranscriptColor }>

export type TranscriptColorKey = keyof typeof TRANSCRIPT_COLORS
const isTranscriptColorKey = (value: string): value is TranscriptColorKey => isKeyOf(TRANSCRIPT_COLORS, value)
export const TRANSCRIPT_COLOR_KEYS: readonly TranscriptColorKey[] = Object.keys(TRANSCRIPT_COLORS).filter(isTranscriptColorKey)

/** A hex colour or a `var(--token)` reference; anything else from JSON is dropped. */
export type TranscriptColor = `#${string}` | `var(--${string})`
export const isTranscriptColor = (value: unknown): value is TranscriptColor =>
  typeof value === "string" && /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(value)

/**
 * What prose is set in; tool rows and chrome have `toolColor`. `soft` is the
 * theme's strong text at 85% over its background — Cursor's
 * `.markdown-root { opacity: .85 }` on the editor foreground, and within a
 * step of Codex's gray-850/750 body text. `base` and `weak` are the tool-row
 * greys and read as secondary text, not as a body colour.
 */
export const TRANSCRIPT_PROSE_COLORS = ["strong", "soft", "base", "weak"] as const
export type TranscriptProseColor = (typeof TRANSCRIPT_PROSE_COLORS)[number]

/**
 * The treatments an inline `code` span carries beyond the mono face: the
 * shipped pill is tint + hairline ring + medium weight; each variant strips
 * one layer more.
 */
export const TRANSCRIPT_INLINE_CODE = ["pill", "tint", "quiet", "plain"] as const
export type TranscriptInlineCode = (typeof TRANSCRIPT_INLINE_CODE)[number]

/** The shipped `hr` is `height: 0`: a model-authored `---` renders as 32px of nothing. */
export const TRANSCRIPT_RULES = ["hidden", "visible"] as const
export type TranscriptRules = (typeof TRANSCRIPT_RULES)[number]

/** When a link is underlined: shipped only under the pointer. */
export const TRANSCRIPT_LINKS = ["hover", "always", "never"] as const
export type TranscriptLinks = (typeof TRANSCRIPT_LINKS)[number]

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value)

type TranscriptChoices = {
  body?: TranscriptFace
  heading?: TranscriptFace
  mono?: TranscriptFace
  headingScale?: TranscriptHeadingScale
  proseColor?: TranscriptProseColor
  inlineCode?: TranscriptInlineCode
  rules?: TranscriptRules
  links?: TranscriptLinks
}

/**
 * An absent pairing follows the theme's (`composeTranscriptTypography`); an
 * absent knob follows the pairing, then the stylesheet's own value.
 */
export type TranscriptTypography = { pairing?: TranscriptPairing } & TranscriptChoices &
  Partial<Record<TranscriptNumberKey, number>> &
  Partial<Record<TranscriptColorKey, TranscriptColor>>

/** A typography whose pairing is settled: what `resolveTranscriptTypography` renders. */
export type PairedTranscriptTypography = TranscriptTypography & { pairing: TranscriptPairing }

export const DEFAULT_TRANSCRIPT_TYPOGRAPHY: Readonly<TranscriptTypography> = Object.freeze({})

type PairingSpec = { label: string; body: TranscriptFace; heading: TranscriptFace; mono: TranscriptFace } & Omit<
  TranscriptTypography,
  "pairing" | "body" | "heading" | "mono"
>

/**
 * `cursor` is Cursor 3.20.2's conversation as measured in its bundle
 * (`workbench.desktop.main.{css,js}`, Markdown.stylex): `--cursor-font-size-lg`
 * 14px on `--cursor-line-height-lg` 22px, body `-apple-system`, mono
 * `--monaco-monospace-font`; paragraphs and blocks end in
 * `--conversation-block-gap` 16px, lists `gap: --conversation-list-item-gap`
 * 8px at `padding-left: 2em`; inline code `.9em`, bg `--cursor-bg-tertiary`
 * (base at 8%), no ring, inherited weight; `.markdown-root { opacity: .85 }`
 * on the editor foreground; `hr` 1px. Its tool rows and cards are not measured
 * yet, so those knobs keep the stylesheet values.
 * `codex` is the Codex window of ChatGPT.app (`app.asar`, `_MarkdownRoot`):
 * `--codex-chat-font-size` → `--text-base` 14px, `--markdown-line-height` =
 * `--leading-relaxed` 1.625, `--font-ui-weight` 430 in `--color-text`
 * (gray-850 #dcdcdc dark / gray-750 light); `--markdown-space` = size / 4, so
 * adjacent paragraphs sit 14px apart, lists indent by the line height with no
 * item gap, `hr` 1px, code `--font-code-size` → `--text-sm` 13px, `b, strong`
 * semibold; thread width 48rem like ours.
 * `default` is what ships: Cursor's measurements under the Default name.
 */
const CURSOR = {
  body: "system",
  heading: "system",
  mono: "sfmono",
  fontSize: 14,
  lineHeight: 22 / 14,
  tracking: 0,
  paragraphGap: 16,
  blockGap: 16,
  listGap: 8,
  listIndent: 28,
  nestedListIndent: 28,
  codeFontSize: 13,
  inlineCodeSize: 0.9,
  headingScale: "cursor",
  proseColor: "soft",
  inlineCode: "tint",
  rules: "visible",
} as const satisfies Omit<PairingSpec, "label">

export const TRANSCRIPT_PAIRINGS = {
  default: { label: "Default", ...CURSOR },
  cursor: { label: "Cursor", ...CURSOR },
  codex: {
    label: "Codex",
    body: "system",
    heading: "system",
    mono: "sfmono",
    fontSize: 14,
    lineHeight: 1.625,
    tracking: 0,
    paragraphGap: 14,
    blockGap: 14,
    listGap: 0,
    listIndent: 23,
    nestedListIndent: 23,
    bodyWeight: 430,
    codeFontSize: 13,
    headingScale: "codex",
    proseColor: "soft",
    rules: "visible",
  },
  technical: { label: "Technical", body: "system", heading: "sfdisplay", mono: "sfmono", fontSize: 14, lineHeight: 1.55, tracking: -0.08 },
  editorial: { label: "Editorial", body: "charter", heading: "newyork", mono: "sfmono", fontSize: 15.5, lineHeight: 1.55, tracking: 0 },
  quiet: { label: "Quiet", body: "newyork", heading: "newyork", mono: "sfmono", fontSize: 15, lineHeight: 1.6, tracking: 0 },
  humanist: { label: "Humanist", body: "iowan", heading: "avenir", mono: "menlo", fontSize: 15, lineHeight: 1.6, tracking: 0 },
  workbench: { label: "Workbench", body: "seravek", heading: "seravek", mono: "sfmono", fontSize: 15, lineHeight: 1.55, tracking: 0 },
  classic: { label: "Classic", body: "palatino", heading: "hoefler", mono: "menlo", fontSize: 15, lineHeight: 1.62, tracking: 0 },
  swiss: { label: "Swiss", body: "helvetica", heading: "helvetica", mono: "menlo", fontSize: 14, lineHeight: 1.5, tracking: -0.1 },
  slab: { label: "Slab", body: "clarendon", heading: "clarendon", mono: "typewriter", fontSize: 14.5, lineHeight: 1.58, tracking: 0 },
  terminal: { label: "Terminal", body: "sfmono", heading: "sfmono", mono: "sfmono", fontSize: 13, lineHeight: 1.55, tracking: 0 },
} as const satisfies Record<string, PairingSpec>

export type TranscriptPairing = keyof typeof TRANSCRIPT_PAIRINGS

export const isTranscriptPairing = (value: unknown): value is TranscriptPairing =>
  typeof value === "string" && isKeyOf(TRANSCRIPT_PAIRINGS, value)

export const TRANSCRIPT_PAIRING_KEYS: readonly TranscriptPairing[] = Object.keys(TRANSCRIPT_PAIRINGS).filter(isTranscriptPairing)

export type ResolvedTranscriptTypography = Required<TranscriptChoices> &
  Record<TranscriptNumberKey, number | undefined> &
  Record<TranscriptColorKey, TranscriptColor>

const inRange = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= range.min && value <= range.max

/**
 * Persisted settings and theme files arrive as untyped JSON, and a pairing or
 * face removed from the catalogue must fall back rather than leave the
 * transcript unstyled.
 */
export function normalizeTranscriptTypography(value: unknown): TranscriptTypography {
  if (!isRecord(value)) return { ...DEFAULT_TRANSCRIPT_TYPOGRAPHY }
  const record = value
  const result: TranscriptTypography = {}
  if (isTranscriptPairing(record.pairing)) result.pairing = record.pairing
  if (isTranscriptFace(record.body)) result.body = record.body
  if (isTranscriptFace(record.heading)) result.heading = record.heading
  if (isTranscriptFace(record.mono) && TRANSCRIPT_FACES[record.mono].kind === "mono") result.mono = record.mono
  if (isTranscriptHeadingScale(record.headingScale)) result.headingScale = record.headingScale
  if (oneOf(TRANSCRIPT_PROSE_COLORS, record.proseColor)) result.proseColor = record.proseColor
  if (oneOf(TRANSCRIPT_INLINE_CODE, record.inlineCode)) result.inlineCode = record.inlineCode
  if (oneOf(TRANSCRIPT_RULES, record.rules)) result.rules = record.rules
  if (oneOf(TRANSCRIPT_LINKS, record.links)) result.links = record.links
  for (const key of TRANSCRIPT_NUMBER_KEYS) {
    const candidate = record[key]
    if (inRange(candidate, TRANSCRIPT_NUMBERS[key])) result[key] = candidate
  }
  for (const key of TRANSCRIPT_COLOR_KEYS) {
    const candidate = record[key]
    if (isTranscriptColor(candidate)) result[key] = candidate
  }
  return result
}

/**
 * The user's setting over the theme's: a setting that names its own pairing
 * replaces the theme's pairing and overrides wholesale, one that does not
 * layers its overrides on the theme's. No theme choice means the shipped
 * `default` pairing. The theme value arrives as JSON, so it is normalized here.
 */
export function composeTranscriptTypography(setting: TranscriptTypography, theme: unknown): PairedTranscriptTypography {
  if (setting.pairing) return { ...setting, pairing: setting.pairing }
  const base = normalizeTranscriptTypography(theme)
  return { ...base, ...setting, pairing: base.pairing ?? "default" }
}

export function resolveTranscriptTypography(typography: PairedTranscriptTypography): ResolvedTranscriptTypography {
  const pairing: PairingSpec = TRANSCRIPT_PAIRINGS[typography.pairing]
  const numbers: Record<string, number | undefined> = {}
  for (const key of TRANSCRIPT_NUMBER_KEYS) numbers[key] = typography[key] ?? pairing[key] ?? TRANSCRIPT_NUMBERS[key].shipped
  const colors: Record<string, TranscriptColor> = {}
  for (const key of TRANSCRIPT_COLOR_KEYS) colors[key] = typography[key] ?? pairing[key] ?? TRANSCRIPT_COLORS[key].shipped
  const numberKnobs: Record<TranscriptNumberKey, number | undefined> = numbers
  const colorKnobs: Record<TranscriptColorKey, TranscriptColor> = colors
  return {
    ...numberKnobs,
    ...colorKnobs,
    body: typography.body ?? pairing.body,
    heading: typography.heading ?? pairing.heading,
    mono: typography.mono ?? pairing.mono,
    headingScale: typography.headingScale ?? pairing.headingScale ?? "flat",
    proseColor: typography.proseColor ?? pairing.proseColor ?? "strong",
    inlineCode: typography.inlineCode ?? pairing.inlineCode ?? "pill",
    rules: typography.rules ?? pairing.rules ?? "hidden",
    links: typography.links ?? pairing.links ?? "hover",
  }
}

/**
 * `--font-family-ui` is the app-level sans as `theme.css` aliases it at `:root`.
 * A transcript root that rescopes `--font-family-sans` to a named body face
 * still reaches the UI font through it, so a heading set to follow the UI font
 * does not silently take the body face.
 */
const APP_TOKEN: Record<TranscriptFaceKind, string> = {
  sans: "var(--font-family-ui)",
  serif: "var(--font-family-ui)",
  mono: "var(--font-family-mono)",
}

/** The CSS family a face renders in: its stack, or the app token it follows. */
export const transcriptFaceFamily = (face: TranscriptFace) => {
  const entry = TRANSCRIPT_FACES[face]
  return "stack" in entry ? entry.stack : APP_TOKEN[entry.kind]
}

const PROSE_COLOR: Record<Exclude<TranscriptProseColor, "strong">, string> = {
  soft: "color-mix(in oklab, var(--text-strong) 85%, var(--background-base))",
  base: "var(--text-base)",
  weak: "var(--text-weak)",
}

/** Each variant strips one layer off the shipped pill; absent keys keep markdown.css's fallback. */
const INLINE_CODE_STYLE: Record<TranscriptInlineCode, Record<string, string>> = {
  pill: {},
  tint: { "--transcript-inline-code-ring": "none", "--transcript-inline-code-weight": "400" },
  quiet: {
    "--transcript-inline-code-ring": "none",
    "--transcript-inline-code-weight": "400",
    "--transcript-inline-code-bg": "transparent",
    "--transcript-inline-code-padding": "0",
  },
  plain: {
    "--transcript-inline-code-ring": "none",
    "--transcript-inline-code-weight": "inherit",
    "--transcript-inline-code-bg": "transparent",
    "--transcript-inline-code-padding": "0",
    "--transcript-inline-code-family": "inherit",
  },
}

const LINK_STYLE: Record<TranscriptLinks, Record<string, string>> = {
  hover: {},
  always: { "--transcript-link-decoration": "underline" },
  never: { "--transcript-link-hover-decoration": "none" },
}

const UNIT: Record<NumberKnob["unit"], string> = { px: "px", em: "em", ch: "ch", ratio: "", weight: "" }

/**
 * Declarations for the element that roots a transcript. Only what departs from
 * the stylesheet's own value is written, so an untouched knob leaves the
 * element's fallback in charge. A named body face is written to
 * `--font-family-sans` as well as to `font-family`: every row in the transcript
 * (tool rows, user messages, question cards) sets its family from that token
 * rather than inheriting, so only the rescoped token reaches them.
 */
export function transcriptTypographyStyle(resolved: ResolvedTranscriptTypography): Record<string, string> {
  const style: Record<string, string> = {}
  for (const key of TRANSCRIPT_NUMBER_KEYS) {
    const knob = TRANSCRIPT_NUMBERS[key]
    const value = resolved[key]
    if (value === undefined || value === knob.shipped) continue
    style[`--transcript-${knob.css}`] = `${value}${UNIT[knob.unit]}`
  }
  for (const key of TRANSCRIPT_COLOR_KEYS) {
    const knob = TRANSCRIPT_COLORS[key]
    if (resolved[key] !== knob.shipped) style[`--transcript-${knob.css}`] = resolved[key]
  }
  if (resolved.bodyWeight !== undefined && resolved.bodyWeight !== TRANSCRIPT_NUMBERS.bodyWeight.shipped) {
    style["font-weight"] = `${resolved.bodyWeight}`
  }
  if (resolved.proseColor !== "strong") style["--transcript-prose-color"] = PROSE_COLOR[resolved.proseColor]
  if (resolved.rules === "visible") {
    style["--transcript-hr-height"] = "1px"
    style["--transcript-hr-margin"] = "24px"
  }
  Object.assign(style, INLINE_CODE_STYLE[resolved.inlineCode], LINK_STYLE[resolved.links])
  const scale = TRANSCRIPT_HEADING_SCALES[resolved.headingScale]
  if (scale) {
    style["--transcript-heading-line-height"] = "1.25"
    scale.forEach((level, index) => {
      const h = `--transcript-h${index + 1}`
      style[`${h}-size`] = `${level.size}px`
      style[`${h}-weight`] = `${level.weight}`
      style[`${h}-top`] = `${level.top}px`
      style[`${h}-bottom`] = `${level.bottom}px`
      style[`${h}-tracking`] = level.tracking === 0 ? "normal" : `${level.tracking}em`
    })
  }
  const body = TRANSCRIPT_FACES[resolved.body]
  if ("stack" in body) {
    style["font-family"] = body.stack
    style["--font-family-sans"] = body.stack
    style["--transcript-font-family-body"] = body.stack
  }
  if (resolved.heading !== resolved.body) {
    style["--transcript-font-family-heading"] = transcriptFaceFamily(resolved.heading)
  }
  const mono = TRANSCRIPT_FACES[resolved.mono]
  if ("stack" in mono) style["--font-family-mono"] = mono.stack
  return style
}
