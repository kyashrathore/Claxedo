export type Locale =
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

export type LocaleEntry = {
  readonly code: Locale
  readonly intlTag: string
  readonly label: string
  readonly matches: (language: string) => boolean
}

function traditionalChinese(language: string): boolean {
  if (language.includes("hant")) return true
  return language
    .split("-")
    .slice(1)
    .some((tag) => tag === "tw" || tag === "hk" || tag === "mo")
}

const startsWith =
  (...prefixes: readonly string[]) =>
  (language: string) =>
    prefixes.some((prefix) => language.startsWith(prefix))

export const LOCALES: readonly LocaleEntry[] = [
  { code: "en", intlTag: "en", label: "English", matches: startsWith("en") },
  { code: "zh", intlTag: "zh-Hans", label: "简体中文", matches: (l) => l.startsWith("zh") && !traditionalChinese(l) },
  { code: "zht", intlTag: "zh-Hant", label: "繁體中文", matches: (l) => l.startsWith("zh") && traditionalChinese(l) },
  { code: "ko", intlTag: "ko", label: "한국어", matches: startsWith("ko") },
  { code: "de", intlTag: "de", label: "Deutsch", matches: startsWith("de") },
  { code: "es", intlTag: "es", label: "Español", matches: startsWith("es") },
  { code: "fr", intlTag: "fr", label: "Français", matches: startsWith("fr") },
  { code: "da", intlTag: "da", label: "Dansk", matches: startsWith("da") },
  { code: "ja", intlTag: "ja", label: "日本語", matches: startsWith("ja") },
  { code: "pl", intlTag: "pl", label: "Polski", matches: startsWith("pl") },
  { code: "ru", intlTag: "ru", label: "Русский", matches: startsWith("ru") },
  { code: "bs", intlTag: "bs", label: "Bosanski", matches: startsWith("bs") },
  { code: "ar", intlTag: "ar", label: "العربية", matches: startsWith("ar") },
  { code: "no", intlTag: "nb-NO", label: "Norsk", matches: startsWith("no", "nb", "nn") },
  { code: "br", intlTag: "pt-BR", label: "Português (Brasil)", matches: startsWith("pt") },
  { code: "th", intlTag: "th", label: "ไทย", matches: startsWith("th") },
  { code: "tr", intlTag: "tr", label: "Türkçe", matches: startsWith("tr") },
]

const byCode = new Map(LOCALES.map((entry) => [entry.code, entry]))

export function localeEntry(code: Locale): LocaleEntry {
  const entry = byCode.get(code)
  if (!entry) throw new Error(`Unknown locale ${code}`)
  return entry
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && byCode.has(value as Locale)
}

export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.toLowerCase()
    const match = LOCALES.find((entry) => entry.matches(normalized))
    if (match) return match.code
  }
  return "en"
}
