/// <reference types="bun" />
import { afterEach, expect, spyOn, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import type { Translations } from "./dictionary"
import type { Locale } from "./locales"
import { createTranslationRegistry, type TranslationRegistry } from "./translations"

const rail = { en: { "rail.new": "New session" } } satisfies Translations
const panel = { en: { "panel.files": "Files" } } satisfies Translations

afterEach(() => {
  spyOn(console, "warn").mockRestore()
})

function mount(initial: Locale = "en"): { readonly i18n: TranslationRegistry; readonly setLocale: (next: Locale) => void; readonly dispose: () => void } {
  return createRoot((dispose) => {
    const [locale, setLocale] = createSignal<Locale>(initial)
    return { i18n: createTranslationRegistry(locale), setLocale, dispose }
  })
}

function runs(i18n: TranslationRegistry, key: string): { readonly count: () => number; readonly text: () => string } {
  let count = 0
  let text = ""
  createRoot(() =>
    createComputed(() => {
      count += 1
      text = i18n.t(key)
    }),
  )
  return { count: () => count, text: () => text }
}

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test("adding a domain re-runs only the translations that missed", () => {
  const { i18n, dispose } = mount()
  i18n.add(rail)
  const found = runs(i18n, "rail.new")
  const missing = runs(i18n, "panel.files")
  expect([found.count(), missing.count(), missing.text()]).toEqual([1, 1, "panel.files"])
  i18n.add(panel)
  expect([found.count(), missing.count(), missing.text()]).toEqual([1, 2, "Files"])
  i18n.add(panel)
  expect([found.count(), missing.count()]).toEqual([1, 2])
  dispose()
})

test("removing a domain re-runs every translation, and its keys stop resolving", () => {
  const { i18n, dispose } = mount()
  i18n.add(rail)
  const remove = i18n.add(panel)
  const files = runs(i18n, "panel.files")
  const kept = runs(i18n, "rail.new")
  remove()
  expect([files.text(), kept.text(), kept.count()]).toEqual(["panel.files", "New session", 2])
  dispose()
})

test("a domain added under a locale it loads lazily starts that load, and the fallen-back labels re-run when it lands", async () => {
  const lazy = { en: { "panel.files": "Files" }, fr: async () => ({ default: { "panel.files": "Fichiers" } }) } satisfies Translations
  const { i18n, dispose } = mount("fr")
  i18n.add(lazy)
  const files = runs(i18n, "panel.files")
  expect([files.text(), i18n.pending("fr")]).toEqual(["Files", true])
  await settled()
  expect([files.text(), files.count(), i18n.pending("fr")]).toEqual(["Fichiers", 2, false])
  dispose()
})

test("loading a locale ahead of switching to it leaves nothing to fall back on at the switch", async () => {
  const lazy = { en: { "panel.files": "Files" }, de: async () => ({ default: { "panel.files": "Dateien" } }) } satisfies Translations
  const { i18n, setLocale, dispose } = mount()
  i18n.add(lazy)
  const files = runs(i18n, "panel.files")
  await i18n.load("de")
  expect([files.text(), files.count()]).toEqual(["Files", 1])
  setLocale("de")
  expect([files.text(), files.count()]).toEqual(["Dateien", 2])
  dispose()
})

test("a locale whose strings fail to load is logged, keeps showing English, and is tried again on the next load", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  let attempts = 0
  const flaky = {
    en: { "panel.files": "Files" },
    fr: () => (++attempts === 1 ? Promise.reject(new TypeError("Failed to fetch dynamically imported module")) : Promise.resolve({ default: { "panel.files": "Fichiers" } })),
  } satisfies Translations
  const { i18n, dispose } = mount("fr")
  i18n.add(flaky)
  const files = runs(i18n, "panel.files")
  await settled()
  expect([files.text(), warn.mock.calls.length, i18n.pending("fr")]).toEqual(["Files", 1, true])
  await i18n.load("fr")
  expect([files.text(), warn.mock.calls.length, attempts]).toEqual(["Fichiers", 1, 2])
  dispose()
})
