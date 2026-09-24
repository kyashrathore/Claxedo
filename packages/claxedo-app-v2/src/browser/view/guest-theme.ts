import type { BrowserWebview } from "../bridge"
import { GUEST_THEME_CHANNEL } from "../guest"

const TOKEN_SOURCES = {
  bg: "--background-strong",
  fg: "--text-strong",
  muted: "--text-weak",
  border: "--border-base",
  accent: "--text-interactive-base",
  "accent-hover": "--border-interactive-hover",
} as const

export function themeTokens(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement)
  const tokens: Record<string, string> = {}
  for (const [key, source] of Object.entries(TOKEN_SOURCES)) {
    const value = styles.getPropertyValue(source).trim()
    if (value) tokens[key] = value
  }
  return tokens
}

export function sendThemeTokens(element: BrowserWebview): void {
  const send = element.send
  if (!send) return
  try {
    send.call(element, GUEST_THEME_CHANNEL, themeTokens())
  } catch (error) {
    console.warn("browser: theme tokens not delivered to the guest", error)
  }
}

export function watchTheme(element: BrowserWebview): () => void {
  const observer = new MutationObserver(() => sendThemeTokens(element))
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme", "class", "style"] })
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const onChange = () => sendThemeTokens(element)
  media.addEventListener("change", onChange)
  return () => {
    observer.disconnect()
    media.removeEventListener("change", onChange)
  }
}
