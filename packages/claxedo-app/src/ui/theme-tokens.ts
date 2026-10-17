export type ThemeColorScheme = "light" | "dark"

const THEME_ATTRIBUTES = ["data-color-scheme", "data-theme", "class", "style"]

export function readThemeTokens(sources: Readonly<Record<string, string>>): Record<string, string> {
  const styles = getComputedStyle(document.documentElement)
  const tokens: Record<string, string> = {}
  for (const [key, source] of Object.entries(sources)) {
    const value = styles.getPropertyValue(source).trim()
    if (value) tokens[key] = value
  }
  return tokens
}

export function readThemeColorScheme(): ThemeColorScheme {
  return document.documentElement.dataset.colorScheme === "dark" ? "dark" : "light"
}

export function watchThemeTokens(onChange: () => void): () => void {
  const observer = new MutationObserver(() => onChange())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES })
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  media.addEventListener("change", onChange)
  return () => {
    observer.disconnect()
    media.removeEventListener("change", onChange)
  }
}
