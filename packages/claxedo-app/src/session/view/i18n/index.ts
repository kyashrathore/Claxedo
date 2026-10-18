import type { Translations } from "@/i18n"
import { sessionScreenEnglish, type SessionScreenTextKey } from "./en"

export type { SessionScreenTextKey } from "./en"

export const sessionScreenEnglishDictionaries = {
  en: sessionScreenEnglish,
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
} satisfies Translations<SessionScreenTextKey>
