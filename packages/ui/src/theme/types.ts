import type { PairedTranscriptTypography } from "./transcript-typography"

export type HexColor = `#${string}`

export interface OklchColor {
  l: number // Lightness 0-1
  c: number // Chroma 0-0.4+
  h: number // Hue 0-360
}

export interface ThemeSeedColors {
  neutral: HexColor
  primary: HexColor
  success: HexColor
  warning: HexColor
  error: HexColor
  info: HexColor
  interactive: HexColor
  diffAdd: HexColor
  diffDelete: HexColor
}

export interface ThemePaletteColors {
  neutral: HexColor
  ink: HexColor
  primary: HexColor
  success: HexColor
  warning: HexColor
  error: HexColor
  info: HexColor
  accent?: HexColor
  interactive?: HexColor
  diffAdd?: HexColor
  diffDelete?: HexColor
}

type ThemeVariantBase = {
  overrides?: Record<string, ColorValue>
  v2Overrides?: Record<string, V2ColorValue>
}

export type ThemeVariant =
  | ({ seeds: ThemeSeedColors; palette?: never } & ThemeVariantBase)
  | ({ palette: ThemePaletteColors; seeds?: never } & ThemeVariantBase)

export interface DesktopTheme {
  $schema?: string
  name: string
  id: string
  light: ThemeVariant
  dark: ThemeVariant
  /** The transcript pairing (and overrides) the theme reads in unless the user picks their own. */
  transcript?: PairedTranscriptTypography
}

export type TokenCategory =
  | "background"
  | "surface"
  | "text"
  | "border"
  | "icon"
  | "input"
  | "button"
  | "syntax"
  | "markdown"
  | "diff"
  | "avatar"

export type ThemeToken = string

export type CssVarRef = `var(--${string})`

/** What `withAlpha` emits: an `rgba(r, g, b, a)` functional color. */
export type RgbaColor = `rgba(${string})`

export type ColorValue = HexColor | CssVarRef | RgbaColor

/**
 * A raw CSS value for a v2 token. Wider than `ColorValue` on purpose: the v2
 * token space also carries composite `box-shadow` values (see
 * `v2/mapping.ts`), so it cannot be narrowed to a colour.
 */
export type V2ColorValue = string

export type ResolvedTheme = Record<ThemeToken, ColorValue>

export type ResolvedV2Theme = Record<string, V2ColorValue>
