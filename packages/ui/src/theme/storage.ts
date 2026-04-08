import type { DesktopTheme } from "./types"

const STORAGE_KEY = "opencode-imported-themes"

function parse(input: string | null) {
  if (!input) return []
  try {
    const next = JSON.parse(input)
    return Array.isArray(next) ? next : []
  } catch {
    return []
  }
}

function valid(input: unknown): input is DesktopTheme {
  return !!input && typeof input === "object" && "id" in input && "light" in input && "dark" in input
}

export function loadStoredThemes() {
  if (typeof localStorage === "undefined") return {}
  return parse(localStorage.getItem(STORAGE_KEY))
    .filter(valid)
    .reduce<Record<string, DesktopTheme>>((map, item) => {
      map[item.id] = item
      return map
    }, {})
}

export function saveStoredTheme(theme: DesktopTheme) {
  if (typeof localStorage === "undefined") return
  const map = loadStoredThemes()
  map[theme.id] = theme
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.values(map)))
}
