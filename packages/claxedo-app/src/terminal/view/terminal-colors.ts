import { withAlpha, type HexColor } from "@/ui/utils"
import { TERMINAL_FONT_FAMILY } from "../backend/options"
import type { TerminalColors } from "../backend/types"

type Mode = "light" | "dark"

const SEEDS: Record<Mode, { background: HexColor; foreground: HexColor }> = {
  light: { background: "#fcfcfc", foreground: "#211e1e" },
  dark: { background: "#191515", foreground: "#d4d4d4" },
}

const SELECTION_ALPHA: Record<Mode, number> = { light: 0.2, dark: 0.25 }

function hexColor(value: string): HexColor | undefined {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value as HexColor
  return /^#[0-9a-f]{8}$/i.test(value) ? (value.slice(0, 7) as HexColor) : undefined
}

function currentMode(): Mode {
  const declared = document.documentElement.dataset.colorScheme
  if (declared === "dark" || declared === "light") return declared
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function cssColor(name: string): string | undefined {
  const value = cssVariable(name)
  return hexColor(value) ?? (/^rgba?\(/i.test(value) ? value : undefined)
}

export function terminalColors(): TerminalColors {
  const mode = currentMode()
  const seeds = SEEDS[mode]
  const background = cssColor("--background-stronger") ?? seeds.background
  const foreground = cssColor("--text-stronger") ?? seeds.foreground
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: withAlpha(hexColor(foreground) ?? seeds.foreground, SELECTION_ALPHA[mode]),
  }
}

export function monoFontFamily(): string {
  return cssVariable("--font-family-mono") || TERMINAL_FONT_FAMILY
}

export function observeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-color-scheme", "data-theme", "class", "style"],
  })
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  media.addEventListener("change", onChange)
  return () => {
    observer.disconnect()
    media.removeEventListener("change", onChange)
  }
}
