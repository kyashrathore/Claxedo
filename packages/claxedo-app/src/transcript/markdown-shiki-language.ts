import { bundledLanguages, type BundledLanguage } from "shiki"

export type HighlightLanguage = BundledLanguage | "text"

export function isBundledLanguage(value: string): value is BundledLanguage {
  return value in bundledLanguages
}

export function resolveHighlightLanguage(value: string): HighlightLanguage {
  return isBundledLanguage(value) ? value : "text"
}

export function highlightGrammar(language: HighlightLanguage) {
  return language === "text" ? undefined : bundledLanguages[language]
}
