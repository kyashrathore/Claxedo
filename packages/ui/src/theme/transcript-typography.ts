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
  ],
  clear: [
    { size: 21, weight: 600, top: 34, bottom: 12, tracking: 0 },
    { size: 17, weight: 600, top: 28, bottom: 10, tracking: 0 },
    { size: 15, weight: 600, top: 22, bottom: 6, tracking: 0 },
  ],
  editorial: [
    { size: 25, weight: 620, top: 40, bottom: 14, tracking: -0.02 },
    { size: 19, weight: 600, top: 32, bottom: 10, tracking: -0.012 },
    { size: 15, weight: 640, top: 24, bottom: 6, tracking: 0.01 },
  ],
  /**
   * Cursor's conversation headings: `.composer-message-markdown h1, h2 {1.214em}`,
   * h3 1.133em (Markdown.stylex level3), weight `--cursor-font-weight-semibold`
   * 590, margin-top `calc(14px * 22 / 15)`, margin-bottom `--cursor-spacing-1`.
   */
  cursor: [
    { size: 17, weight: 590, top: 20.5, bottom: 4, tracking: 0 },
    { size: 17, weight: 590, top: 20.5, bottom: 4, tracking: 0 },
    { size: 16, weight: 590, top: 20.5, bottom: 4, tracking: 0 },
  ],
  /**
   * Codex's `_Heading`: h1 1.5×, h2 1.25×, h3 1.125× of the 14px chat size,
   * semibold; h1 has no top margin, h2/h3 sit `4 * --markdown-space` (14px)
   * below the previous block and `--markdown-space` (3.5px) above the next.
   */
  codex: [
    { size: 21, weight: 600, top: 0, bottom: 7, tracking: 0 },
    { size: 17.5, weight: 600, top: 14, bottom: 3.5, tracking: 0 },
    { size: 15.75, weight: 600, top: 14, bottom: 3.5, tracking: 0 },
  ],
} as const satisfies Record<
  string,
  readonly [HeadingLevel, HeadingLevel, HeadingLevel] | undefined
>

type HeadingLevel = { size: number; weight: number; top: number; bottom: number; tracking: number }

export type TranscriptHeadingScale = keyof typeof TRANSCRIPT_HEADING_SCALES

export const isTranscriptHeadingScale = (value: unknown): value is TranscriptHeadingScale =>
  typeof value === "string" && isKeyOf(TRANSCRIPT_HEADING_SCALES, value)

export const TRANSCRIPT_HEADING_SCALE_KEYS: readonly TranscriptHeadingScale[] = Object.keys(
  TRANSCRIPT_HEADING_SCALES,
).filter(isTranscriptHeadingScale)

/**
 * `tracking` is in px; `size` in px; `lineHeight` unitless. A pairing may also
 * pin the knobs that otherwise keep the shipped CSS value.
 *
 * `cursor` is Cursor 3.20.2's conversation as measured in its bundle
 * (`workbench.desktop.main.{css,js}`, Markdown.stylex): `--cursor-font-size-lg`
 * 14px on `--cursor-line-height-lg` 22px, body `-apple-system`, mono
 * `--monaco-monospace-font`; paragraphs and blocks end in
 * `--conversation-block-gap` 16px, lists `gap: --conversation-list-item-gap`
 * 8px at `padding-left: 2em`; inline code `.9em`, bg `--cursor-bg-tertiary`
 * (base at 8%), no ring, inherited weight; `.markdown-root { opacity: .85 }`
 * on the editor foreground; `hr` 1px.
 * `codex` is the Codex window of ChatGPT.app (`app.asar`, `_MarkdownRoot`):
 * `--codex-chat-font-size` → `--text-base` 14px, `--markdown-line-height` =
 * `--leading-relaxed` 1.625, `--font-ui-weight` 430 in `--color-text`
 * (gray-850 #dcdcdc dark / gray-750 light); `--markdown-space` = size / 4, so
 * adjacent paragraphs sit 14px apart, lists indent by the line height with no
 * item gap, `hr` 1px, code `--font-code-size` → `--text-sm` 13px, `b, strong`
 * semibold; thread width 48rem like ours.
 */
export const TRANSCRIPT_PAIRINGS = {
  default: { label: "Default", body: "system", heading: "system", mono: "sfmono", size: 14, lineHeight: 1.6, tracking: 0 },
  cursor: {
    label: "Cursor",
    body: "system",
    heading: "system",
    mono: "sfmono",
    size: 14,
    lineHeight: 22 / 14,
    tracking: 0,
    paragraphGap: 16,
    blockGap: 16,
    listGap: 8,
    listIndent: 28,
    codeFontSize: 13,
    inlineCodeSize: 0.9,
    headingScale: "cursor",
    proseColor: "soft",
    inlineCode: "tint",
    rules: "visible",
  },
  codex: {
    label: "Codex",
    body: "system",
    heading: "system",
    mono: "sfmono",
    size: 14,
    lineHeight: 1.625,
    tracking: 0,
    paragraphGap: 14,
    blockGap: 14,
    listGap: 0,
    listIndent: 23,
    bodyWeight: 430,
    codeFontSize: 13,
    headingScale: "codex",
    proseColor: "soft",
    rules: "visible",
  },
  technical: { label: "Technical", body: "system", heading: "sfdisplay", mono: "sfmono", size: 14, lineHeight: 1.55, tracking: -0.08 },
  editorial: { label: "Editorial", body: "charter", heading: "newyork", mono: "sfmono", size: 15.5, lineHeight: 1.55, tracking: 0 },
  quiet: { label: "Quiet", body: "newyork", heading: "newyork", mono: "sfmono", size: 15, lineHeight: 1.6, tracking: 0 },
  humanist: { label: "Humanist", body: "iowan", heading: "avenir", mono: "menlo", size: 15, lineHeight: 1.6, tracking: 0 },
  workbench: { label: "Workbench", body: "seravek", heading: "seravek", mono: "sfmono", size: 15, lineHeight: 1.55, tracking: 0 },
  classic: { label: "Classic", body: "palatino", heading: "hoefler", mono: "menlo", size: 15, lineHeight: 1.62, tracking: 0 },
  swiss: { label: "Swiss", body: "helvetica", heading: "helvetica", mono: "menlo", size: 14, lineHeight: 1.5, tracking: -0.1 },
  slab: { label: "Slab", body: "clarendon", heading: "clarendon", mono: "typewriter", size: 14.5, lineHeight: 1.58, tracking: 0 },
  terminal: { label: "Terminal", body: "sfmono", heading: "sfmono", mono: "sfmono", size: 13, lineHeight: 1.55, tracking: 0 },
} as const satisfies Record<
  string,
  {
    label: string
    body: TranscriptFace
    heading: TranscriptFace
    mono: TranscriptFace
    size: number
    lineHeight: number
    tracking: number
    inlineCodeSize?: number
    codeFontSize?: number
    paragraphGap?: number
    blockGap?: number
    listGap?: number
    listIndent?: number
    bodyWeight?: number
    boldWeight?: number
    headingScale?: TranscriptHeadingScale
    measure?: number
    proseColor?: TranscriptProseColor
    inlineCode?: TranscriptInlineCode
    rules?: TranscriptRules
  }
>

export type TranscriptPairing = keyof typeof TRANSCRIPT_PAIRINGS

/** The union of the literal pairings widened, so optional knobs read as absent rather than as a type error. */
type PairingSpec = {
  body: TranscriptFace
  heading: TranscriptFace
  mono: TranscriptFace
  size: number
  lineHeight: number
  tracking: number
  inlineCodeSize?: number
  codeFontSize?: number
  paragraphGap?: number
  blockGap?: number
  listGap?: number
  listIndent?: number
  bodyWeight?: number
  boldWeight?: number
  headingScale?: TranscriptHeadingScale
  measure?: number
  proseColor?: TranscriptProseColor
  inlineCode?: TranscriptInlineCode
  rules?: TranscriptRules
}

export const isTranscriptPairing = (value: unknown): value is TranscriptPairing =>
  typeof value === "string" && isKeyOf(TRANSCRIPT_PAIRINGS, value)

export const TRANSCRIPT_PAIRING_KEYS: readonly TranscriptPairing[] = Object.keys(TRANSCRIPT_PAIRINGS).filter(isTranscriptPairing)

export const TRANSCRIPT_RANGES = {
  fontSize: { min: 13, max: 18 },
  lineHeight: { min: 1.35, max: 1.9 },
  tracking: { min: -0.3, max: 0.15 },
  inlineCodeSize: { min: 0.75, max: 1 },
  codeFontSize: { min: 11, max: 16 },
  paragraphGap: { min: 0, max: 28 },
  blockGap: { min: 0, max: 32 },
  listGap: { min: 0, max: 12 },
  listIndent: { min: 16, max: 40 },
  bodyWeight: { min: 350, max: 500 },
  boldWeight: { min: 400, max: 800 },
  measure: { min: 48, max: 110 },
} as const

/**
 * What prose is set in; tool rows and chrome keep their own tokens. `soft` is
 * the theme's strong text at 85% over its background — Cursor's
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

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value)

type NumericKnob = keyof typeof TRANSCRIPT_RANGES

/**
 * An absent pairing follows the theme's (`composeTranscriptTypography`); an
 * absent override follows the pairing (faces, size, leading, tracking) or the
 * shipped value (everything else). Units: px for sizes, gaps and tracking; em
 * for inline code; ch for the measure.
 */
export type TranscriptTypography = {
  pairing?: TranscriptPairing
  body?: TranscriptFace
  heading?: TranscriptFace
  mono?: TranscriptFace
  fontSize?: number
  lineHeight?: number
  tracking?: number
  inlineCodeSize?: number
  codeFontSize?: number
  paragraphGap?: number
  blockGap?: number
  listGap?: number
  listIndent?: number
  bodyWeight?: number
  boldWeight?: number
  headingScale?: TranscriptHeadingScale
  measure?: number
  proseColor?: TranscriptProseColor
  inlineCode?: TranscriptInlineCode
  rules?: TranscriptRules
}

/** A typography whose pairing is settled: what `resolveTranscriptTypography` renders. */
export type PairedTranscriptTypography = TranscriptTypography & { pairing: TranscriptPairing }

export const DEFAULT_TRANSCRIPT_TYPOGRAPHY: Readonly<TranscriptTypography> = Object.freeze({})

export type ResolvedTranscriptTypography = {
  body: TranscriptFace
  heading: TranscriptFace
  mono: TranscriptFace
  fontSize: number
  lineHeight: number
  tracking: number
  inlineCodeSize: number
  codeFontSize: number
  paragraphGap: number
  /** Undefined keeps the shipped per-block margins (lists 12px, quotes 16px, code 24px). */
  blockGap: number | undefined
  listGap: number
  listIndent: number
  bodyWeight: number
  boldWeight: number
  headingScale: TranscriptHeadingScale
  /** Undefined keeps the shipped responsive column (48rem, 880px from 2xl). */
  measure: number | undefined
  proseColor: TranscriptProseColor
  inlineCode: TranscriptInlineCode
  rules: TranscriptRules
}

/** What markdown.css renders with no variable set. */
const SHIPPED = {
  inlineCodeSize: 0.8,
  codeFontSize: 13,
  paragraphGap: 6,
  listGap: 8,
  listIndent: 32,
  bodyWeight: 400,
  boldWeight: 600,
} as const

const inRange = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= range.min && value <= range.max

/**
 * Persisted settings arrive as untyped JSON, and a pairing or face removed from
 * the catalogue must fall back rather than leave the transcript unstyled.
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
  for (const key of Object.keys(TRANSCRIPT_RANGES).filter(isNumericKnob)) {
    const value = record[key]
    if (inRange(value, TRANSCRIPT_RANGES[key])) result[key] = value
  }
  return result
}

const isNumericKnob = (value: string): value is NumericKnob => isKeyOf(TRANSCRIPT_RANGES, value)

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
  return {
    body: typography.body ?? pairing.body,
    heading: typography.heading ?? pairing.heading,
    mono: typography.mono ?? pairing.mono,
    fontSize: typography.fontSize ?? pairing.size,
    lineHeight: typography.lineHeight ?? pairing.lineHeight,
    tracking: typography.tracking ?? pairing.tracking,
    inlineCodeSize: typography.inlineCodeSize ?? pairing.inlineCodeSize ?? SHIPPED.inlineCodeSize,
    codeFontSize: typography.codeFontSize ?? pairing.codeFontSize ?? SHIPPED.codeFontSize,
    paragraphGap: typography.paragraphGap ?? pairing.paragraphGap ?? SHIPPED.paragraphGap,
    blockGap: typography.blockGap ?? pairing.blockGap,
    listGap: typography.listGap ?? pairing.listGap ?? SHIPPED.listGap,
    listIndent: typography.listIndent ?? pairing.listIndent ?? SHIPPED.listIndent,
    bodyWeight: typography.bodyWeight ?? pairing.bodyWeight ?? SHIPPED.bodyWeight,
    boldWeight: typography.boldWeight ?? pairing.boldWeight ?? SHIPPED.boldWeight,
    headingScale: typography.headingScale ?? pairing.headingScale ?? "flat",
    measure: typography.measure ?? pairing.measure,
    proseColor: typography.proseColor ?? pairing.proseColor ?? "strong",
    inlineCode: typography.inlineCode ?? pairing.inlineCode ?? "pill",
    rules: typography.rules ?? pairing.rules ?? "hidden",
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

/**
 * Declarations for the element that roots a transcript. A named body face is
 * written to `--font-family-sans` as well as to `font-family`: every row in the
 * transcript (tool rows, user messages, question cards) sets its family from
 * that token rather than inheriting, so only the rescoped token reaches them.
 * `.ui-markdown` and `.ui-user-message` consume the `--transcript-*` variables.
 */
export function transcriptTypographyStyle(resolved: ResolvedTranscriptTypography): Record<string, string> {
  const style: Record<string, string> = {
    "--transcript-font-size": `${resolved.fontSize}px`,
    "--transcript-line-height": `${resolved.lineHeight}`,
    "--transcript-letter-spacing": resolved.tracking === 0 ? "normal" : `${resolved.tracking}px`,
    "--transcript-inline-code-size": `${resolved.inlineCodeSize}em`,
    "--transcript-code-font-size": `${resolved.codeFontSize}px`,
    "--transcript-paragraph-gap": `${resolved.paragraphGap}px`,
    "--transcript-list-gap": `${resolved.listGap}px`,
    "--transcript-list-indent": `${resolved.listIndent}px`,
    "--transcript-bold-weight": `${resolved.boldWeight}`,
  }
  if (resolved.measure !== undefined) style["--transcript-measure"] = `${resolved.measure}ch`
  if (resolved.blockGap !== undefined) style["--transcript-block-gap"] = `${resolved.blockGap}px`
  if (resolved.bodyWeight !== SHIPPED.bodyWeight) {
    style["font-weight"] = `${resolved.bodyWeight}`
    style["--transcript-body-weight"] = `${resolved.bodyWeight}`
  }
  if (resolved.proseColor !== "strong") style["--transcript-prose-color"] = PROSE_COLOR[resolved.proseColor]
  if (resolved.rules === "visible") {
    style["--transcript-hr-height"] = "1px"
    style["--transcript-hr-margin"] = "24px"
  }
  Object.assign(style, INLINE_CODE_STYLE[resolved.inlineCode])
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
