/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import type { Translations } from "./dictionary"
import { createTranslationRegistry, type TranslationRegistry } from "./translations"

const rail = { en: { "rail.new": "New session" } } satisfies Translations
const panel = { en: { "panel.files": "Files" } } satisfies Translations

function mount(): { readonly i18n: TranslationRegistry; readonly dispose: () => void } {
  return createRoot((dispose) => {
    const [locale] = createSignal("en" as const)
    return { i18n: createTranslationRegistry(locale), dispose }
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
