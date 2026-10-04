import { describe, expect, test } from "bun:test"
import { ThemeParseError, parseDesktopTheme } from "./parse"
import oc2ThemeJson from "./themes/oc-2.json"
import ayuThemeJson from "./themes/ayu.json"
import codexThemeJson from "./themes/codex.json"

const minimalSeeds = {
  neutral: "#f4f4f4",
  primary: "#2563eb",
  success: "#168447",
  warning: "#c65d19",
  error: "#d43d37",
  info: "#247cc0",
  interactive: "#147cc1",
  diffAdd: "#168447",
  diffDelete: "#d43d37",
}

const minimal = {
  name: "Minimal",
  id: "minimal",
  light: { seeds: minimalSeeds },
  dark: { seeds: minimalSeeds },
}

/** Parsing only validates, so a bundled theme must survive it byte-identically. */
function reserialize(theme: unknown): unknown {
  return JSON.parse(JSON.stringify(theme))
}

describe("parseDesktopTheme", () => {
  test("returns a bundled palette theme unchanged", () => {
    expect(reserialize(parseDesktopTheme(oc2ThemeJson))).toEqual(oc2ThemeJson)
  })

  test("returns a bundled seeds theme unchanged", () => {
    expect(reserialize(parseDesktopTheme(ayuThemeJson))).toEqual(ayuThemeJson)
  })

  test("accepts a variant with no overrides", () => {
    expect(parseDesktopTheme(minimal).light.overrides).toBeUndefined()
  })

  test("a theme's transcript choice survives with its pairing and knobs; the Codex theme carries the codex pairing", () => {
    expect(parseDesktopTheme(minimal).transcript).toBeUndefined()
    expect(parseDesktopTheme({ ...minimal, transcript: { pairing: "swiss", listGap: 4 } }).transcript).toEqual({
      pairing: "swiss",
      listGap: 4,
    })
    expect(parseDesktopTheme(codexThemeJson).transcript).toEqual({ pairing: "codex" })
  })

  test("a transcript block without a known pairing names its path", () => {
    expect(() => parseDesktopTheme({ ...minimal, transcript: { pairing: "gone" } })).toThrow(
      new ThemeParseError("theme.transcript.pairing", "expected a transcript pairing name"),
    )
    expect(() => parseDesktopTheme({ ...minimal, transcript: "codex" })).toThrow(ThemeParseError)
  })

  test("names the offending path when a seed is not a hex color", () => {
    const broken = { ...minimal, dark: { seeds: { ...minimalSeeds, primary: "rebeccapurple" } } }
    expect(() => parseDesktopTheme(broken)).toThrow(
      new ThemeParseError("theme.dark.seeds.primary", 'expected a hex color, got "rebeccapurple"'),
    )
  })

  test("names the offending path when an override is not a color value", () => {
    const broken = { ...minimal, light: { seeds: minimalSeeds, overrides: { "text-base": "black" } } }
    expect(() => parseDesktopTheme(broken)).toThrow(/theme\.light\.overrides\.text-base/)
  })

  test("rejects a variant that defines neither seeds nor palette", () => {
    expect(() => parseDesktopTheme({ ...minimal, light: {} })).toThrow(/theme\.light: requires/)
  })

  test("rejects a variant that defines both seeds and palette", () => {
    const broken = { ...minimal, light: { seeds: minimalSeeds, palette: {} } }
    expect(() => parseDesktopTheme(broken)).toThrow(/theme\.light: cannot define both/)
  })

  test("rejects a missing name", () => {
    const { name, ...rest } = minimal
    void name
    expect(() => parseDesktopTheme(rest)).toThrow(/theme\.name: expected a string/)
  })

  test("uses the caller's path label", () => {
    expect(() => parseDesktopTheme(null, "themes/broken.json")).toThrow(
      /themes\/broken\.json: expected an object/,
    )
  })

  test("keeps v2 overrides that are not colors, such as shadows", () => {
    const shadow = "0px 1px 2px 0px var(--v2-alpha-dark-40)"
    const parsed = parseDesktopTheme({
      ...minimal,
      light: { seeds: minimalSeeds, v2Overrides: { "v2-shadow-sm": shadow } },
    })
    expect(parsed.light.v2Overrides).toEqual({ "v2-shadow-sm": shadow })
  })

  // Overrides become `--${key}: ${value}` lines inside the generated sheet's
  // textContent, so a name or value carrying declaration syntax would let a
  // hostile theme file write arbitrary page CSS.
  test("rejects override token names that are not plain identifiers", () => {
    for (const key of ["x; } body { display:none", "x}", "x: red; --y"]) {
      const broken = { ...minimal, light: { seeds: minimalSeeds, overrides: { [key]: "#fff" } } }
      expect(() => parseDesktopTheme(broken), key).toThrow(/invalid token name/)
    }
  })

  test("rejects an override var() reference with trailing payload", () => {
    const broken = {
      ...minimal,
      light: { seeds: minimalSeeds, overrides: { "text-base": "var(--x); } body { display:none" } },
    }
    expect(() => parseDesktopTheme(broken)).toThrow(/theme\.light\.overrides\.text-base/)
  })

  test("rejects v2 override values that could break out of a declaration", () => {
    for (const value of ["red; } * { display:none }", "url(https://evil.test/x.css)", "red } @import 'x'"]) {
      const broken = {
        ...minimal,
        light: { seeds: minimalSeeds, v2Overrides: { "v2-shadow-sm": value } },
      }
      expect(() => parseDesktopTheme(broken), value).toThrow(/plain CSS declaration value/)
    }
  })

  test("rejects a theme id that would inject a selector", () => {
    const broken = { ...minimal, id: 'x"] {} body { display:none }' }
    expect(() => parseDesktopTheme(broken)).toThrow(/theme\.id: expected a slug id/)
  })
})
