import { bundledLanguages, type BundledLanguage } from "shiki"

/**
 * Shiki's grammar names, plus the built-in plain-text pseudo-language used when a fence
 * names something shiki does not bundle. `text` is deliberately NOT a `BundledLanguage`:
 * it has no grammar to load, only a tokenizer that emits the source unstyled.
 */
export type HighlightLanguage = BundledLanguage | "text"

export function isBundledLanguage(value: string): value is BundledLanguage {
  return value in bundledLanguages
}

/** The language a fence resolves to; anything shiki does not bundle falls back to plain text. */
export function resolveHighlightLanguage(value: string): HighlightLanguage {
  return isBundledLanguage(value) ? value : "text"
}

/**
 * The grammar to load before tokenizing, or `undefined` when the language needs none.
 *
 * Plain text is the case that needs stating: `bundledLanguages` has no `text` entry, so
 * indexing it for the fallback language yields `undefined` and asks shiki to load nothing,
 * which throws inside the worker. Returning `undefined` makes "needs no grammar" a value
 * the caller handles rather than an accident of a missing key.
 */
export function highlightGrammar(language: HighlightLanguage) {
  return language === "text" ? undefined : bundledLanguages[language]
}
