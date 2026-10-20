import type { Translations } from "@/i18n"
import { composerEnglish, type ComposerTextKey } from "./en"

export type { ComposerTextKey } from "./en"

export const composerEnglishDictionaries = {
  en: composerEnglish,
  ar: () => import("../locales/ar"),
  br: () => import("../locales/br"),
  bs: () => import("../locales/bs"),
  da: () => import("../locales/da"),
  de: () => import("../locales/de"),
  es: () => import("../locales/es"),
  fr: () => import("../locales/fr"),
  ja: () => import("../locales/ja"),
  ko: () => import("../locales/ko"),
  no: () => import("../locales/no"),
  pl: () => import("../locales/pl"),
  ru: () => import("../locales/ru"),
  th: () => import("../locales/th"),
  tr: () => import("../locales/tr"),
  zh: () => import("../locales/zh"),
  zht: () => import("../locales/zht"),
} satisfies Translations<ComposerTextKey>
