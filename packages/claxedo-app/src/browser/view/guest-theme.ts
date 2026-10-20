import { readThemeTokens, watchThemeTokens } from "@/ui/utils"
import type { BrowserWebview } from "../bridge"
import { GUEST_THEME_CHANNEL } from "../guest"

const TOKEN_SOURCES = {
  bg: "--v2-background-bg-base",
  fg: "--v2-text-text-base",
  muted: "--v2-text-text-muted",
  border: "--v2-border-border-base",
  accent: "--v2-text-text-accent",
  "accent-hover": "--v2-text-text-accent-hover",
} as const

export function themeTokens(): Record<string, string> {
  return readThemeTokens(TOKEN_SOURCES)
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
  return watchThemeTokens(() => sendThemeTokens(element))
}
