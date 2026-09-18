import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TRANSCRIPT_TYPOGRAPHY,
  TRANSCRIPT_COLOR_KEYS,
  TRANSCRIPT_FACES,
  TRANSCRIPT_NUMBER_KEYS,
  TRANSCRIPT_PAIRINGS,
  composeTranscriptTypography,
  normalizeTranscriptTypography,
  resolveTranscriptTypography,
  transcriptTypographyStyle,
} from "./transcript-typography"

describe("normalizeTranscriptTypography", () => {
  test("non-objects and unknown pairings read as no pairing at all, which is 'the theme's'", () => {
    expect(normalizeTranscriptTypography(undefined)).toEqual(DEFAULT_TRANSCRIPT_TYPOGRAPHY)
    expect(normalizeTranscriptTypography("editorial")).toEqual({})
    expect(normalizeTranscriptTypography({ pairing: "retired", fontSize: 15 })).toEqual({ fontSize: 15 })
  })

  test("keeps every valid override and drops each invalid one independently", () => {
    expect(
      normalizeTranscriptTypography({
        pairing: "editorial",
        body: "charter",
        heading: "nope",
        mono: "charter",
        fontSize: 16,
        lineHeight: 9,
      }),
    ).toEqual({ pairing: "editorial", body: "charter", fontSize: 16 })
  })

  test("a sans face is not accepted for the mono slot", () => {
    expect(normalizeTranscriptTypography({ pairing: "default", mono: "helvetica" })).toEqual({ pairing: "default" })
    expect(normalizeTranscriptTypography({ pairing: "default", mono: "menlo" })).toEqual({
      pairing: "default",
      mono: "menlo",
    })
  })

  test("numbers outside a knob's range are dropped, boundaries kept, and every knob in the catalogue is read", () => {
    expect(normalizeTranscriptTypography({ pairing: "default", fontSize: 9 }).fontSize).toBeUndefined()
    expect(normalizeTranscriptTypography({ pairing: "default", fontSize: 20 }).fontSize).toBe(20)
    expect(normalizeTranscriptTypography({ pairing: "default", lineHeight: Number.NaN }).lineHeight).toBeUndefined()
    expect(normalizeTranscriptTypography({ pairing: "default", lineHeight: 1.35 }).lineHeight).toBe(1.35)
    expect(normalizeTranscriptTypography({ pairing: "default", codeFontSize: 40, measure: 64, boldWeight: "700" })).toEqual({
      pairing: "default",
      measure: 64,
    })
    expect(normalizeTranscriptTypography({ toolSize: 12, toolRowHeight: 28, turnGap: 16, groupCap: 999 })).toEqual({
      toolSize: 12,
      toolRowHeight: 28,
      turnGap: 16,
    })
  })

  test("a colour knob takes a hex or a token reference and nothing else", () => {
    expect(normalizeTranscriptTypography({ toolColor: "var(--text-base)", linkColor: "#08f", markerColor: "red", metaColor: "url(x)" })).toEqual({
      toolColor: "var(--text-base)",
      linkColor: "#08f",
    })
    expect(normalizeTranscriptTypography({ links: "always" }).links).toBe("always")
    expect(normalizeTranscriptTypography({ links: "sometimes" }).links).toBeUndefined()
  })

  test("an unknown heading scale is dropped; a known one kept", () => {
    expect(normalizeTranscriptTypography({ pairing: "default", headingScale: "huge" }).headingScale).toBeUndefined()
    expect(normalizeTranscriptTypography({ pairing: "default", headingScale: "clear" }).headingScale).toBe("clear")
  })

  test("the enumerated prose knobs accept only their catalogue", () => {
    expect(
      normalizeTranscriptTypography({
        pairing: "default",
        proseColor: "base",
        inlineCode: "neon",
        rules: "visible",
        bodyWeight: 430,
        listGap: 99,
      }),
    ).toEqual({ pairing: "default", proseColor: "base", rules: "visible", bodyWeight: 430 })
  })
})

describe("composeTranscriptTypography", () => {
  test("no pairing anywhere resolves to the shipped default", () => {
    expect(composeTranscriptTypography({}, undefined)).toEqual({ pairing: "default" })
    expect(composeTranscriptTypography({ fontSize: 15 }, undefined)).toEqual({ pairing: "default", fontSize: 15 })
  })

  test("a setting without a pairing layers its overrides on the theme's pairing and overrides", () => {
    const theme = { pairing: "codex", listGap: 4, fontSize: 15 }
    expect(composeTranscriptTypography({}, theme)).toEqual({ pairing: "codex", listGap: 4, fontSize: 15 })
    expect(composeTranscriptTypography({ fontSize: 16 }, theme)).toEqual({ pairing: "codex", listGap: 4, fontSize: 16 })
  })

  test("a setting that names a pairing replaces the theme's choice and its overrides wholesale", () => {
    expect(composeTranscriptTypography({ pairing: "swiss" }, { pairing: "codex", listGap: 4 })).toEqual({ pairing: "swiss" })
  })

  test("a theme's transcript is untrusted JSON: a retired pairing or bad knob in it falls away", () => {
    expect(composeTranscriptTypography({}, { pairing: "gone", fontSize: 99, measure: 64 })).toEqual({
      pairing: "default",
      measure: 64,
    })
    expect(composeTranscriptTypography({}, "codex")).toEqual({ pairing: "default" })
  })
})

describe("resolveTranscriptTypography", () => {
  test("an override wins over the pairing; the rest follows the pairing or the stylesheet's own value", () => {
    const resolved = resolveTranscriptTypography({ pairing: "swiss", body: "charter", fontSize: 17, codeFontSize: 14, toolSize: 13 })
    expect(resolved).toMatchObject({
      body: "charter",
      heading: "helvetica",
      mono: "menlo",
      fontSize: 17,
      lineHeight: 1.5,
      tracking: -0.1,
      inlineCodeSize: 0.8,
      codeFontSize: 14,
      paragraphGap: 6,
      blockGap: undefined,
      listGap: 8,
      listIndent: 32,
      bodyWeight: 400,
      boldWeight: 600,
      headingScale: "flat",
      measure: undefined,
      proseColor: "strong",
      inlineCode: "pill",
      rules: "hidden",
      links: "hover",
      toolSize: 13,
      toolLineHeight: 1.5,
      toolColor: "var(--text-weak)",
      turnGap: 24,
      scrollbarSize: 8,
    })
    for (const key of TRANSCRIPT_NUMBER_KEYS) expect(key in resolved, key).toBe(true)
    for (const key of TRANSCRIPT_COLOR_KEYS) expect(typeof resolved[key], key).toBe("string")
    expect(resolveTranscriptTypography({ pairing: "swiss", tracking: 0 }).tracking).toBe(0)
  })

  test("a pairing's pinned knobs apply under the shipped fallback and under an explicit override", () => {
    const cursor = resolveTranscriptTypography({ pairing: "cursor" })
    expect(cursor).toMatchObject({
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
      bodyWeight: 400,
    })
    expect(cursor.lineHeight).toBeCloseTo(22 / 14)
    expect(
      resolveTranscriptTypography({ pairing: "cursor", paragraphGap: 12, headingScale: "flat", inlineCode: "pill" }),
    ).toMatchObject({ paragraphGap: 12, headingScale: "flat", inlineCode: "pill" })
    expect(resolveTranscriptTypography({ pairing: "codex" })).toMatchObject({
      body: "system",
      fontSize: 14,
      lineHeight: 1.625,
      bodyWeight: 430,
      codeFontSize: 13,
      paragraphGap: 14,
      blockGap: 14,
      listGap: 0,
      listIndent: 23,
      headingScale: "codex",
      proseColor: "soft",
      inlineCode: "pill",
      rules: "visible",
    })
  })

  test("every pairing names faces that exist and a mono face for the mono slot", () => {
    for (const pairing of Object.values(TRANSCRIPT_PAIRINGS)) {
      expect(TRANSCRIPT_FACES[pairing.mono].kind).toBe("mono")
      expect(TRANSCRIPT_FACES[pairing.body]).toBeDefined()
      expect(TRANSCRIPT_FACES[pairing.heading]).toBeDefined()
    }
  })
})

describe("transcriptTypographyStyle", () => {
  test("only what departs from the stylesheet's own value is written; a knob at its shipped value leaves the fallback in charge", () => {
    expect(transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "technical" }))).toEqual({
      "--transcript-line-height": "1.55",
      "--transcript-letter-spacing": "-0.08px",
      "--transcript-font-family-heading": TRANSCRIPT_FACES.sfdisplay.stack,
    })
    const tool = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "technical", toolSize: 12 }))
    expect(tool["--transcript-tool-size"]).toBe("12px")
    expect(transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "technical", toolSize: 14 }))["--transcript-tool-size"]).toBeUndefined()
  })

  test("the Default pairing is Cursor's measurements: the two resolve identically", () => {
    expect(resolveTranscriptTypography({ pairing: "default" })).toEqual(resolveTranscriptTypography({ pairing: "cursor" }))
    expect(transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "default" }))).toMatchObject({
      "--transcript-line-height": `${22 / 14}`,
      "--transcript-paragraph-gap": "16px",
      "--transcript-block-gap": "16px",
      "--transcript-list-indent": "28px",
      "--transcript-nested-list-indent": "28px",
      "--transcript-inline-code-size": "0.9em",
      "--transcript-inline-code-ring": "none",
      "--transcript-hr-height": "1px",
      "--transcript-h1-size": "17px",
      "--transcript-h4-size": "16px",
      "--transcript-prose-color": "color-mix(in oklab, var(--text-strong) 85%, var(--background-base))",
    })
  })

  test("a colour knob and a link policy emit their variables", () => {
    const style = transcriptTypographyStyle(
      resolveTranscriptTypography({ pairing: "technical", toolColor: "#123456", scrollbarThumb: "var(--text-base)", links: "always" }),
    )
    expect(style["--transcript-tool-color"]).toBe("#123456")
    expect(style["--transcript-scrollbar-thumb"]).toBe("var(--text-base)")
    expect(style["--transcript-link-decoration"]).toBe("underline")
    expect(transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "technical", links: "never" }))["--transcript-link-hover-decoration"]).toBe("none")
  })

  test("prose colour, body weight, rules, block gap and an inline-code variant emit only when they depart", () => {
    const style = transcriptTypographyStyle(
      resolveTranscriptTypography({
        pairing: "default",
        proseColor: "base",
        bodyWeight: 430,
        rules: "visible",
        blockGap: 14,
        inlineCode: "quiet",
      }),
    )
    expect(style["--transcript-prose-color"]).toBe("var(--text-base)")
    expect(style["font-weight"]).toBe("430")
    expect(style["--transcript-body-weight"]).toBe("430")
    expect(style["--transcript-hr-height"]).toBe("1px")
    expect(style["--transcript-block-gap"]).toBe("14px")
    expect(style["--transcript-inline-code-ring"]).toBe("none")
    expect(style["--transcript-inline-code-bg"]).toBe("transparent")
    expect(style["--transcript-inline-code-family"]).toBeUndefined()
    const plain = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "default", inlineCode: "plain" }))
    expect(plain["--transcript-inline-code-family"]).toBe("inherit")
  })

  test("a measure and a heading scale emit their variables; flat emits none for headings", () => {
    const style = transcriptTypographyStyle(
      resolveTranscriptTypography({ pairing: "default", measure: 64, headingScale: "editorial" }),
    )
    expect(style["--transcript-measure"]).toBe("64ch")
    expect(style["--transcript-h1-size"]).toBe("25px")
    expect(style["--transcript-h1-weight"]).toBe("620")
    expect(style["--transcript-h1-top"]).toBe("40px")
    expect(style["--transcript-h1-bottom"]).toBe("14px")
    expect(style["--transcript-h1-tracking"]).toBe("-0.02em")
    expect(style["--transcript-h3-size"]).toBe("15px")
    const subtle = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "default", headingScale: "subtle" }))
    expect(subtle["--transcript-h2-tracking"]).toBe("normal")
    expect(subtle["--transcript-heading-line-height"]).toBe("1.25")
    expect(Object.keys(subtle).filter((key) => /^--transcript-(h\d|heading)/.test(key))).toHaveLength(21)
  })

  test("the soft prose colour is the theme's strong text mixed 85% toward its background", () => {
    const style = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "cursor" }))
    expect(style["--transcript-prose-color"]).toBe("color-mix(in oklab, var(--text-strong) 85%, var(--background-base))")
  })

  test("a named body face rescopes the sans token so tool rows and user text take it, and sets the prose variable; a differing heading gets its own", () => {
    const style = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "editorial" }))
    expect(style["font-family"]).toBe(TRANSCRIPT_FACES.charter.stack)
    expect(style["--font-family-sans"]).toBe(TRANSCRIPT_FACES.charter.stack)
    expect(style["--transcript-font-family-body"]).toBe(TRANSCRIPT_FACES.charter.stack)
    expect(style["--transcript-font-family-heading"]).toBe(TRANSCRIPT_FACES.newyork.stack)
    expect(style["--font-family-mono"]).toBeUndefined()
    expect(style["--transcript-font-size"]).toBe("15.5px")
  })

  test("a heading that follows the app UI font reads the fixed UI alias, since the sans token is rescoped beneath it", () => {
    const style = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "editorial", heading: "system" }))
    expect(style["--transcript-font-family-heading"]).toBe("var(--font-family-ui)")
    expect(style["--font-family-sans"]).toBe(TRANSCRIPT_FACES.charter.stack)
  })

  test("a system body face leaves the sans token to the theme", () => {
    const style = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "codex" }))
    expect(style["--font-family-sans"]).toBeUndefined()
    expect(style["font-family"]).toBeUndefined()
  })

  test("a named mono face overrides the mono token for the whole transcript; tracking is emitted in px", () => {
    const style = transcriptTypographyStyle(resolveTranscriptTypography({ pairing: "technical", mono: "menlo" }))
    expect(style["--font-family-mono"]).toBe(TRANSCRIPT_FACES.menlo.stack)
    expect(style["--transcript-letter-spacing"]).toBe("-0.08px")
    expect(style["--transcript-font-family-heading"]).toBe(TRANSCRIPT_FACES.sfdisplay.stack)
  })
})
