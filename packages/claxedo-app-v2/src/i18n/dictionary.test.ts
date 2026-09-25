/// <reference types="bun" />
import { afterEach, expect, spyOn, test } from "bun:test"
import { createDictionaries, type Translations } from "./dictionary"

const rail = { en: { "rail.new": "New session", "rail.search": "Search" }, de: { "rail.new": "Neue Sitzung" } } satisfies Translations
const panel = { en: { "panel.files": "Files" }, fr: { "panel.files": "Fichiers" } } satisfies Translations

afterEach(() => {
  spyOn(console, "error").mockRestore()
})

test("a key resolves in the locale, then English, then as itself", () => {
  const dictionaries = createDictionaries()
  dictionaries.add(rail)
  expect(dictionaries.resolve("de", "rail.new")).toEqual({ text: "Neue Sitzung", found: true })
  expect(dictionaries.resolve("de", "rail.search")).toEqual({ text: "Search", found: false })
  expect(dictionaries.resolve("en", "rail.search")).toEqual({ text: "Search", found: true })
  expect(dictionaries.resolve("en", "rail.missing")).toEqual({ text: "rail.missing", found: false })
})

test("a domain added after a locale was read joins that locale's dictionary", () => {
  const dictionaries = createDictionaries()
  dictionaries.add(rail)
  expect(dictionaries.resolve("fr", "panel.files")).toEqual({ text: "panel.files", found: false })
  expect(dictionaries.add(panel)).toBe(true)
  expect(dictionaries.resolve("fr", "panel.files")).toEqual({ text: "Fichiers", found: true })
  expect(dictionaries.resolve("en", "panel.files")).toEqual({ text: "Files", found: true })
})

test("adding a domain twice changes nothing, and removing it drops only its keys", () => {
  const dictionaries = createDictionaries()
  dictionaries.add(rail)
  dictionaries.add(panel)
  expect(dictionaries.add(rail)).toBe(false)
  expect(dictionaries.resolve("en", "panel.files").text).toBe("Files")
  expect(dictionaries.remove(panel)).toBe(true)
  expect(dictionaries.remove(panel)).toBe(false)
  expect(dictionaries.resolve("en", "panel.files")).toEqual({ text: "panel.files", found: false })
  expect(dictionaries.resolve("de", "rail.new").text).toBe("Neue Sitzung")
})

test("a duplicate English key keeps the first definition and is logged", () => {
  const error = spyOn(console, "error").mockImplementation(() => {})
  const dictionaries = createDictionaries()
  dictionaries.add(rail)
  dictionaries.resolve("en", "rail.new")
  dictionaries.add({ en: { "rail.new": "Another" } })
  expect(dictionaries.resolve("en", "rail.new").text).toBe("New session")
  expect(error).toHaveBeenCalledTimes(1)
})
