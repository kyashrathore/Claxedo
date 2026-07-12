/**
 * The single manifest of "which locales exist and how do they load."
 *
 * This is the one place a contributor edits to add a language: append an entry
 * with a loader pointing at the new dictionary file (and translate that file).
 * `src/platform/i18n/provider.tsx`'s five previously hand-synced structures (the
 * `Locale` union, `LOCALES`, `INTL`, `LABEL_KEY`, `loaders`, and
 * `localeMatchers`) are all derived from `LOCALE_ENTRIES` below — none of them
 * are edited by hand anymore.
 *
 * Note the file backing locale "br" is `pt-BR.ts`, not `br.ts` — ISO 639-1
 * "br" is Breton, not Brazilian Portuguese; the locale *code* "br" is kept
 * (it is persisted in user localStorage/cookies) but the file name now
 * reflects its actual content and IETF tag (`pt-BR`).
 */

export type LocaleCode =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "bs"
  | "ar"
  | "no"
  | "br"
  | "th"
  | "tr"

export type LocaleSource = { dict: Record<string, string> }

export type LocaleEntry = {
  /** Persisted locale identifier (localStorage, `oc_locale` cookie, URL). */
  code: LocaleCode
  /**
   * Loads this locale's flat string dictionary, merged from BOTH this
   * package's `src/i18n/<file>.ts` and `@/ui`'s
   * `src/i18n/<code>.ts` (the ui package's strings win on key collision,
   * matching pre-manifest behavior).
   */
  loader: () => Promise<LocaleSource>
  /** BCP-47 tag passed to `Intl` APIs. */
  intlTag: string
  /** i18n key whose translated value is this locale's display label. */
  labelKey: `language.${string}`
  /** Whether a lowercased `navigator.language` entry should resolve to this locale.
   *  Matchers must be mutually exclusive (see zh/zht) — matching does not depend
   *  on manifest order. */
  matches: (language: string) => boolean
}

function loadMerged(app: Promise<LocaleSource>, ui: Promise<LocaleSource>): Promise<LocaleSource> {
  return Promise.all([app, ui]).then(([a, b]) => ({ dict: { ...a.dict, ...b.dict } }))
}

/**
 * A lowercased navigator-language entry denotes Traditional Chinese when it
 * carries the Hant script token, or a region subtag (TW/HK/MO) whose default
 * script is Traditional. Bug fix 2026-07-11: previously only "hant" was
 * checked, so zh-TW/zh-HK users silently got Simplified Chinese.
 */
function isTraditionalChinese(language: string): boolean {
  if (language.includes("hant")) return true
  const subtags = language.split("-").slice(1)
  return subtags.some((tag) => tag === "tw" || tag === "hk" || tag === "mo")
}

export const LOCALE_ENTRIES: readonly LocaleEntry[] = [
  {
    code: "en",
    loader: () => loadMerged(import("./en").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/en")),
    intlTag: "en",
    labelKey: "language.en",
    matches: (language) => language.startsWith("en"),
  },
  {
    code: "zh",
    loader: () => loadMerged(import("./zh").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/zh")),
    intlTag: "zh-Hans",
    labelKey: "language.zh",
    // Excludes the Traditional-script signals (hant script token, and the
    // TW/HK/MO region subtags whose default script is Traditional) so this and
    // zht's matcher stay mutually
    // exclusive regardless of manifest order.
    matches: (language) => language.startsWith("zh") && !isTraditionalChinese(language),
  },
  {
    code: "zht",
    loader: () => loadMerged(import("./zht").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/zht")),
    intlTag: "zh-Hant",
    labelKey: "language.zht",
    matches: (language) => language.startsWith("zh") && isTraditionalChinese(language),
  },
  {
    code: "ko",
    loader: () => loadMerged(import("./ko").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/ko")),
    intlTag: "ko",
    labelKey: "language.ko",
    matches: (language) => language.startsWith("ko"),
  },
  {
    code: "de",
    loader: () => loadMerged(import("./de").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/de")),
    intlTag: "de",
    labelKey: "language.de",
    matches: (language) => language.startsWith("de"),
  },
  {
    code: "es",
    loader: () => loadMerged(import("./es").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/es")),
    intlTag: "es",
    labelKey: "language.es",
    matches: (language) => language.startsWith("es"),
  },
  {
    code: "fr",
    loader: () => loadMerged(import("./fr").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/fr")),
    intlTag: "fr",
    labelKey: "language.fr",
    matches: (language) => language.startsWith("fr"),
  },
  {
    code: "da",
    loader: () => loadMerged(import("./da").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/da")),
    intlTag: "da",
    labelKey: "language.da",
    matches: (language) => language.startsWith("da"),
  },
  {
    code: "ja",
    loader: () => loadMerged(import("./ja").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/ja")),
    intlTag: "ja",
    labelKey: "language.ja",
    matches: (language) => language.startsWith("ja"),
  },
  {
    code: "pl",
    loader: () => loadMerged(import("./pl").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/pl")),
    intlTag: "pl",
    labelKey: "language.pl",
    matches: (language) => language.startsWith("pl"),
  },
  {
    code: "ru",
    loader: () => loadMerged(import("./ru").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/ru")),
    intlTag: "ru",
    labelKey: "language.ru",
    matches: (language) => language.startsWith("ru"),
  },
  {
    code: "bs",
    loader: () => loadMerged(import("./bs").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/bs")),
    intlTag: "bs",
    labelKey: "language.bs",
    matches: (language) => language.startsWith("bs"),
  },
  {
    code: "ar",
    loader: () => loadMerged(import("./ar").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/ar")),
    intlTag: "ar",
    labelKey: "language.ar",
    matches: (language) => language.startsWith("ar"),
  },
  {
    code: "no",
    loader: () => loadMerged(import("./no").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/no")),
    intlTag: "nb-NO",
    labelKey: "language.no",
    matches: (language) =>
      language.startsWith("no") || language.startsWith("nb") || language.startsWith("nn"),
  },
  {
    code: "br",
    // App-side file is pt-BR.ts (see file header); ui package's file is still
    // named by locale code, br.ts.
    loader: () => loadMerged(import("./pt-BR").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/br")),
    intlTag: "pt-BR",
    labelKey: "language.br",
    matches: (language) => language.startsWith("pt"),
  },
  {
    code: "th",
    loader: () => loadMerged(import("./th").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/th")),
    intlTag: "th",
    labelKey: "language.th",
    matches: (language) => language.startsWith("th"),
  },
  {
    code: "tr",
    loader: () => loadMerged(import("./tr").then((m) => ({ dict: m.dict })), import("@opencode-ai/ui/i18n/tr")),
    intlTag: "tr",
    labelKey: "language.tr",
    matches: (language) => language.startsWith("tr"),
  },
] as const

// Compile-time exhaustiveness check: fails to type-check if a LocaleCode
// member has no entry above (mirrors src/i18n/locale-parity.test.ts's
// runtime check of the same invariant).
type _MissingLocaleEntries = Exclude<LocaleCode, (typeof LOCALE_ENTRIES)[number]["code"]>
const _localeEntriesCoverAllCodes: _MissingLocaleEntries extends never ? true : [
  "LOCALE_ENTRIES is missing:",
  _MissingLocaleEntries,
] = true
void _localeEntriesCoverAllCodes
