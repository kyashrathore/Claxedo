import { expect, test } from "bun:test"
import { highlightGrammar, resolveHighlightLanguage } from "./markdown-shiki-language"

test("an unbundled fence language resolves to plain text and loads no grammar", () => {
  expect(resolveHighlightLanguage("typescript")).toBe("typescript")
  expect(highlightGrammar(resolveHighlightLanguage("typescript"))).toBeDefined()

  // `text` is shiki's plain-text pseudo-language, not a bundled grammar. Asking for it
  // by name, or naming a language shiki does not bundle, must both land on it and skip
  // the load: `bundledLanguages.text` is undefined, and loading undefined throws.
  expect(resolveHighlightLanguage("text")).toBe("text")
  expect(resolveHighlightLanguage("not-a-language")).toBe("text")
  expect(resolveHighlightLanguage("")).toBe("text")
  expect(highlightGrammar("text")).toBeUndefined()
})
