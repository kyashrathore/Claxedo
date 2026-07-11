import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { cloudStrings } from "./cloud-strings"
import { LOCALE_ENTRIES, type LocaleCode } from "./locales"
import missingKeysBaseline from "./missing-keys-baseline.json"

// This suite is the net that catches translation drift: a non-English locale
// silently missing a key (falls back to English with no warning), a
// mistranslated {{placeholder}}, or the locale manifest pointing at a file
// that no longer exists in this package or in @claxedo/ui. None of that used
// to be tested (see docs/plans/2026-07-10-003 appendix, "i18n" section).

const NON_EN_ENTRIES = LOCALE_ENTRIES.filter((entry) => entry.code !== "en")
const BASELINE = missingKeysBaseline as Record<string, string[]>

function tokenSet(value: string): string[] {
  const matches = value.match(/\{\{\s*\w+\s*\}\}/g) ?? []
  return [...new Set(matches.map((m) => m.replace(/[{}\s]/g, "")))].sort()
}

async function loadAppDict(code: LocaleCode): Promise<Record<string, string>> {
  // The app-side dictionary file backing locale "br" is pt-BR.ts (see
  // src/i18n/locales.ts's file header) — every other code matches its file 1:1.
  const filename = code === "br" ? "pt-BR" : code
  const mod = (await import(`./${filename}`)) as { dict: Record<string, string> }
  return mod.dict
}

describe("locale-parity: missing keys vs en.ts", () => {
  test("missing-keys-baseline.json has exactly one entry per non-English locale in LOCALE_ENTRIES", () => {
    const baselineCodes = Object.keys(BASELINE).sort()
    const manifestCodes = NON_EN_ENTRIES.map((entry) => entry.code).sort()
    expect(baselineCodes).toEqual(manifestCodes)
  })

  for (const entry of NON_EN_ENTRIES) {
    test(`${entry.code}'s missing-key set vs en.ts matches its baselined entry exactly (new drift or a stale baseline both fail)`, async () => {
      const dict = await loadAppDict(entry.code)
      const dictKeys = new Set(Object.keys(dict))
      const actualMissing = Object.keys(en)
        .filter((key) => !dictKeys.has(key))
        .sort()
      const baselined = [...(BASELINE[entry.code] ?? [])].sort()
      expect(actualMissing).toEqual(baselined)
    })
  }
})

describe("locale-parity: {{placeholder}} token parity vs en.ts", () => {
  for (const entry of NON_EN_ENTRIES) {
    test(`${entry.code}'s translated keys use the same {{placeholder}} token set as en.ts for every shared key`, async () => {
      const dict = await loadAppDict(entry.code)
      const mismatches: Array<{ key: string; en: string[]; locale: string[] }> = []
      for (const [key, value] of Object.entries(en)) {
        const localeValue = dict[key]
        if (localeValue === undefined) continue // tracked separately by the missing-keys suite
        const enTokens = tokenSet(value)
        const localeTokens = tokenSet(localeValue)
        if (JSON.stringify(enTokens) !== JSON.stringify(localeTokens)) {
          mismatches.push({ key, en: enTokens, locale: localeTokens })
        }
      }
      expect(mismatches).toEqual([])
    })
  }
})

describe("locale-parity: manifest/file drift", () => {
  test("LOCALE_ENTRIES has no duplicate locale codes", () => {
    const codes = LOCALE_ENTRIES.map((entry) => entry.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  test("every LABEL_KEY referenced by the manifest exists as a real en.ts key", () => {
    const missing = LOCALE_ENTRIES.filter((entry) => !(entry.labelKey in en)).map((entry) => entry.code)
    expect(missing).toEqual([])
  })

  for (const entry of LOCALE_ENTRIES) {
    test(`${entry.code}'s loader resolves a non-empty merged dict (backing files exist in this dir and @claxedo/ui's i18n)`, async () => {
      const source = await entry.loader()
      expect(Object.keys(source.dict).length).toBeGreaterThan(0)
    })
  }
})

describe("locale-parity: LocaleEntry.matches navigator-language resolution", () => {
  // detectLocale() in src/context/language.tsx lowercases each
  // navigator.languages entry and picks the FIRST manifest entry whose
  // matches() returns true, falling back to "en" when none match. Matchers
  // are documented as mutually exclusive (locales.ts, LocaleEntry.matches),
  // so asserting toEqual([expected]) below pins BOTH the resolved code AND
  // that exactly one matcher fires — which is what makes resolution
  // independent of manifest order (the zh/zht invariant WP-A6 introduced).

  function matchingCodes(navigatorLanguage: string): LocaleCode[] {
    const normalized = navigatorLanguage.toLowerCase()
    return LOCALE_ENTRIES.filter((entry) => entry.matches(normalized)).map((entry) => entry.code)
  }

  const CASES: Array<[navigatorLanguage: string, expected: LocaleCode]> = [
    ["en", "en"],
    ["en-GB", "en"],
    ["en-US", "en"],
    ["zh", "zh"],
    ["zh-CN", "zh"],
    ["zh-Hans", "zh"],
    ["zh-Hans-CN", "zh"],
    ["zh-Hant", "zht"],
    ["zh-Hant-TW", "zht"],
    ["zh-Hant-HK", "zht"],
    ["ko", "ko"],
    ["ko-KR", "ko"],
    ["de", "de"],
    ["de-AT", "de"],
    ["es", "es"],
    ["es-419", "es"],
    ["fr", "fr"],
    ["fr-CA", "fr"],
    ["da", "da"],
    ["da-DK", "da"],
    ["ja", "ja"],
    ["ja-JP", "ja"],
    ["pl", "pl"],
    ["pl-PL", "pl"],
    ["ru", "ru"],
    ["ru-RU", "ru"],
    ["bs", "bs"],
    ["bs-BA", "bs"],
    ["ar", "ar"],
    ["ar-EG", "ar"],
    ["no", "no"],
    ["nb-NO", "no"],
    ["nn-NO", "no"],
    ["pt-BR", "br"],
    ["pt", "br"],
    ["pt-PT", "br"],
    ["th", "th"],
    ["th-TH", "th"],
    ["tr", "tr"],
    ["tr-TR", "tr"],
  ]

  for (const [language, expected] of CASES) {
    test(`navigator language "${language}" resolves to locale "${expected}" via exactly one matcher, independent of manifest order`, () => {
      expect(matchingCodes(language)).toEqual([expected])
    })
  }

  test("every LOCALE_ENTRIES code is reachable from at least one representative navigator language in the table", () => {
    const covered = new Set(CASES.map(([, expected]) => expected))
    const unreachable = LOCALE_ENTRIES.map((entry) => entry.code).filter((code) => !covered.has(code))
    expect(unreachable).toEqual([])
  })

  test('unknown languages ("xx-YY", "eo") match no entry, so detectLocale falls back to "en"', () => {
    expect(matchingCodes("xx-YY")).toEqual([])
    expect(matchingCodes("eo")).toEqual([])
  })

  test('"zh-TW", "zh-HK", "zh-MO" (Traditional-default regions, no script subtag) resolve to "zht"', () => {
    // Bug fixed 2026-07-11: the zh/zht split previously keyed on the "hant"
    // script token only, silently serving Simplified to Taiwan/Hong Kong/
    // Macau users. Region subtags whose default script is Traditional now
    // imply zht.
    expect(matchingCodes("zh-TW")).toEqual(["zht"])
    expect(matchingCodes("zh-HK")).toEqual(["zht"])
    expect(matchingCodes("zh-MO")).toEqual(["zht"])
  })

  test('"zh-CN", "zh-SG", and bare "zh" still resolve to Simplified "zh" after the Traditional-region fix', () => {
    expect(matchingCodes("zh-CN")).toEqual(["zh"])
    expect(matchingCodes("zh-SG")).toEqual(["zh"])
    expect(matchingCodes("zh")).toEqual(["zh"])
  })
})

describe("locale-parity: cloud-strings.ts internal key parity", () => {
  const cloudLocales = Object.keys(cloudStrings) as Array<keyof typeof cloudStrings>
  const enKeys = Object.keys(cloudStrings.en).sort()

  for (const locale of cloudLocales) {
    if (locale === "en") continue
    test(`cloudStrings.${locale} defines exactly the same keys as cloudStrings.en`, () => {
      const keys = Object.keys(cloudStrings[locale]).sort()
      expect(keys).toEqual(enKeys)
    })
  }
})
