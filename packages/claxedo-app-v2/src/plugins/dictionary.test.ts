import { describe, expect, test } from "bun:test"
import { moduleDictionary, PluginDictionaryError, translated } from "./dictionary"

describe("a live plugin's dictionary", () => {
  test("is its bundle's dictionary export, looked up by locale then English then the key", () => {
    const dictionary = moduleDictionary({ dictionary: { en: { "fixture.hello": "Hello {{name}}" }, de: { "fixture.hello": "Hallo {{name}}" } } })
    expect(translated(dictionary, "de", "fixture.hello")).toBe("Hallo {{name}}")
    expect(translated(dictionary, "fr", "fixture.hello")).toBe("Hello {{name}}")
    expect(translated(dictionary, "fr", "fixture.other")).toBe("fixture.other")
    expect(translated(undefined, "en", "plain text")).toBe("plain text")
  })

  test("a bundle without one has none; a malformed one fails the load", () => {
    expect(moduleDictionary({})).toBeUndefined()
    expect(() => moduleDictionary({ dictionary: { de: { a: "b" } } })).toThrow(PluginDictionaryError)
    expect(() => moduleDictionary({ dictionary: { en: { a: 1 } } })).toThrow(PluginDictionaryError)
    expect(() => moduleDictionary({ dictionary: { en: { a: "b" }, de: "x" } })).toThrow(PluginDictionaryError)
  })
})
