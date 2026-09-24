import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import {
  chromeColor,
  defaultThemeId,
  isColorScheme,
  themeIdPattern,
  themeStorageKeys,
  type ColorMode,
  type ColorScheme,
  type ThemeRecord,
} from "./model"

const storage = () => (typeof localStorage === "object" ? localStorage : undefined)

const readScheme = (): ColorScheme => {
  const value = storage()?.getItem(themeStorageKeys.colorScheme)
  return isColorScheme(value) ? value : "system"
}

const readThemeId = () => storage()?.getItem(themeStorageKeys.theme) ?? defaultThemeId

const systemMode = (): ColorMode =>
  typeof window === "object" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

const modeFor = (scheme: ColorScheme): ColorMode => (scheme === "system" ? systemMode() : scheme)

function ensureStyleElement(id: string) {
  const existing = document.getElementById(id)
  if (existing instanceof HTMLStyleElement) return existing
  existing?.remove()
  const element = document.createElement("style")
  element.id = id
  document.head.appendChild(element)
  return element
}

function paint(themeId: string, mode: ColorMode, theme: ThemeRecord | undefined) {
  const html = document.documentElement
  html.dataset.theme = themeId
  html.dataset.colorScheme = mode
  html.style.colorScheme = mode
  html.style.backgroundColor = chromeColor(mode)
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", chromeColor(mode))
  document.getElementById("claxedo-theme-preload")?.remove()
  const css = theme ? theme.stylesheet[mode] : ""
  ensureStyleElement("claxedo-theme").textContent = css ? `html[data-theme="${themeId}"]{${css}}` : ""
}

function cache(theme: ThemeRecord | undefined) {
  const store = storage()
  if (!store) return
  for (const mode of ["light", "dark"] as const) {
    const key = themeStorageKeys.stylesheet(mode)
    if (theme) store.setItem(key, theme.stylesheet[mode])
    else store.removeItem(key)
  }
}

export function createThemeStore() {
  const scheme = readScheme()
  const [store, setStore] = createStore({
    scheme,
    mode: modeFor(scheme),
    themeId: readThemeId(),
    themes: {} as Record<string, ThemeRecord>,
  })

  const theme = () => (store.themeId === defaultThemeId ? undefined : store.themes[store.themeId])

  onMount(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    makeEventListener(media, "change", () => {
      if (store.scheme === "system") setStore("mode", systemMode())
    })
    makeEventListener(window, "storage", (event) => {
      if (event.key === themeStorageKeys.colorScheme && isColorScheme(event.newValue)) {
        setStore({ scheme: event.newValue, mode: modeFor(event.newValue) })
      }
      if (event.key === themeStorageKeys.theme && event.newValue && themeIdPattern.test(event.newValue)) {
        setStore("themeId", event.newValue)
      }
    })
  })

  createEffect(() => paint(store.themeId, store.mode, theme()))

  const setColorScheme = (next: ColorScheme) => {
    setStore({ scheme: next, mode: modeFor(next) })
    storage()?.setItem(themeStorageKeys.colorScheme, next)
  }

  const setTheme = (id: string) => {
    if (id !== defaultThemeId && !store.themes[id]) throw new Error(`Theme "${id}" is not registered`)
    setStore("themeId", id)
    storage()?.setItem(themeStorageKeys.theme, id)
    cache(theme())
  }

  const registerTheme = (record: ThemeRecord) => {
    if (!themeIdPattern.test(record.id)) throw new Error(`Theme id "${record.id}" is not a slug`)
    setStore("themes", record.id, record)
    if (store.themeId === record.id) cache(record)
  }

  const unregisterTheme = (id: string) => {
    if (store.themeId === id) setTheme(defaultThemeId)
    setStore("themes", id, undefined!)
  }

  return {
    colorScheme: () => store.scheme,
    mode: () => store.mode,
    themeId: () => store.themeId,
    themes: () => [{ id: defaultThemeId, name: "Claxedo" }, ...Object.values(store.themes).map(({ id, name }) => ({ id, name }))],
    setColorScheme,
    setTheme,
    registerTheme,
    unregisterTheme,
  }
}

export type ThemeStore = ReturnType<typeof createThemeStore>
