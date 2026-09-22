import { isRecord } from "@claxedo/helpers/guards"
import { isHexColor } from "./color"
import type {
  ColorValue,
  CssVarRef,
  DesktopTheme,
  HexColor,
  ThemePaletteColors,
  ThemeSeedColors,
  ThemeVariant,
  V2ColorValue,
} from "./types"
import { normalizeTranscriptTypography, type PairedTranscriptTypography } from "./transcript-typography"

/*
 * The single boundary between untyped theme JSON — bundled `themes/*.json` and
 * themes fetched at runtime — and the `DesktopTheme` contract. It mirrors
 * `desktop-theme.schema.json`, which `semantic.test.ts` validates every bundled
 * theme against; keep the two in step.
 */

export class ThemeParseError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`)
    this.name = "ThemeParseError"
  }
}

// Everything below lands in `themeStyleElement.textContent`: a token name
// becomes `--${name}` and a token value the declaration text of the generated
// stylesheet. Neither may carry what ends a declaration (`;`), opens a block
// (`{}`), starts an at-rule (`@`), quotes a string, or fetches a remote
// resource (`url(`), or a hostile theme file writes arbitrary page CSS.
const tokenName = /^[a-zA-Z0-9_-]+$/
const unsafeCssValue = /[;{}@'"`<>\\]|url\s*\(/i

function tokenKey(key: string, path: string): string {
  if (!tokenName.test(key)) throw new ThemeParseError(path, `invalid token name ${JSON.stringify(key)}`)
  return key
}

// Full-match, mirroring the schema's ColorValue: a bare `var(--token)` and
// nothing trailing behind it that could continue the declaration.
function isCssVarRef(value: string): value is CssVarRef {
  return /^var\(--[a-z0-9-]+\)$/.test(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ThemeParseError(path, "expected an object")
  return value
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ThemeParseError(path, "expected a string")
  return value
}

function hex(value: unknown, path: string): HexColor {
  const text = str(value, path)
  if (!isHexColor(text)) throw new ThemeParseError(path, `expected a hex color, got ${JSON.stringify(text)}`)
  return text
}

/** The schema's `ColorValue`: a hex literal or a `var(--token)` reference. */
function colorValue(value: unknown, path: string): ColorValue {
  const text = str(value, path)
  if (isHexColor(text) || isCssVarRef(text)) return text
  throw new ThemeParseError(path, `expected a hex color or var(--token) reference, got ${JSON.stringify(text)}`)
}

function colorMap(value: unknown, path: string): Record<string, ColorValue> {
  return Object.fromEntries(
    Object.entries(record(value, path)).map(([key, entry]) => [tokenKey(key, path), colorValue(entry, `${path}.${key}`)]),
  )
}

function cssDeclValue(value: unknown, path: string): V2ColorValue {
  const text = str(value, path)
  if (unsafeCssValue.test(text)) {
    throw new ThemeParseError(path, `expected a plain CSS declaration value, got ${JSON.stringify(text)}`)
  }
  return text
}

function stringMap(value: unknown, path: string): Record<string, V2ColorValue> {
  return Object.fromEntries(
    Object.entries(record(value, path)).map(([key, entry]) => [tokenKey(key, path), cssDeclValue(entry, `${path}.${key}`)]),
  )
}

function seeds(value: unknown, path: string): ThemeSeedColors {
  const raw = record(value, path)
  return {
    neutral: hex(raw.neutral, `${path}.neutral`),
    primary: hex(raw.primary, `${path}.primary`),
    success: hex(raw.success, `${path}.success`),
    warning: hex(raw.warning, `${path}.warning`),
    error: hex(raw.error, `${path}.error`),
    info: hex(raw.info, `${path}.info`),
    interactive: hex(raw.interactive, `${path}.interactive`),
    diffAdd: hex(raw.diffAdd, `${path}.diffAdd`),
    diffDelete: hex(raw.diffDelete, `${path}.diffDelete`),
  }
}

function optionalHex(raw: Record<string, unknown>, key: string, path: string): HexColor | undefined {
  if (raw[key] === undefined) return undefined
  return hex(raw[key], `${path}.${key}`)
}

function palette(value: unknown, path: string): ThemePaletteColors {
  const raw = record(value, path)
  return {
    neutral: hex(raw.neutral, `${path}.neutral`),
    ink: hex(raw.ink, `${path}.ink`),
    primary: hex(raw.primary, `${path}.primary`),
    success: hex(raw.success, `${path}.success`),
    warning: hex(raw.warning, `${path}.warning`),
    error: hex(raw.error, `${path}.error`),
    info: hex(raw.info, `${path}.info`),
    accent: optionalHex(raw, "accent", path),
    interactive: optionalHex(raw, "interactive", path),
    diffAdd: optionalHex(raw, "diffAdd", path),
    diffDelete: optionalHex(raw, "diffDelete", path),
  }
}

function variant(value: unknown, path: string): ThemeVariant {
  const raw = record(value, path)
  const base = {
    overrides: raw.overrides === undefined ? undefined : colorMap(raw.overrides, `${path}.overrides`),
    v2Overrides: raw.v2Overrides === undefined ? undefined : stringMap(raw.v2Overrides, `${path}.v2Overrides`),
  }

  const hasSeeds = raw.seeds !== undefined
  const hasPalette = raw.palette !== undefined
  if (hasSeeds && hasPalette) throw new ThemeParseError(path, "cannot define both `seeds` and `palette`")
  if (hasSeeds) return { seeds: seeds(raw.seeds, `${path}.seeds`), ...base }
  if (hasPalette) return { palette: palette(raw.palette, `${path}.palette`), ...base }
  throw new ThemeParseError(path, "requires `seeds` or `palette`")
}

/**
 * Validate arbitrary JSON as a `DesktopTheme`. Throws `ThemeParseError` naming
 * the offending path when the value does not match the theme contract.
 */
function themeTranscript(value: unknown, path: string): PairedTranscriptTypography {
  const raw = record(value, path)
  const normalized = normalizeTranscriptTypography(raw)
  if (!normalized.pairing) throw new ThemeParseError(`${path}.pairing`, "expected a transcript pairing name")
  return { ...normalized, pairing: normalized.pairing }
}

// The id is interpolated into the generated sheet's `html[data-theme="…"]`
// selector, so it is held to the schema's slug grammar.
function themeId(value: unknown, path: string): string {
  const text = str(value, path)
  if (!/^[a-z0-9-]+$/.test(text)) throw new ThemeParseError(path, `expected a slug id, got ${JSON.stringify(text)}`)
  return text
}

export function parseDesktopTheme(value: unknown, path = "theme"): DesktopTheme {
  const raw = record(value, path)
  return {
    $schema: raw.$schema === undefined ? undefined : str(raw.$schema, `${path}.$schema`),
    name: str(raw.name, `${path}.name`),
    id: themeId(raw.id, `${path}.id`),
    light: variant(raw.light, `${path}.light`),
    dark: variant(raw.dark, `${path}.dark`),
    ...(raw.transcript === undefined ? {} : { transcript: themeTranscript(raw.transcript, `${path}.transcript`) }),
  }
}
