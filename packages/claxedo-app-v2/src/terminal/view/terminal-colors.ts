import { TERMINAL_FONT_FAMILY } from "../backend/options"
import type { TerminalColors } from "../backend/types"

type Mode = "light" | "dark"

const SEEDS: Record<Mode, { background: string; foreground: string }> = {
  light: { background: "#fcfcfc", foreground: "#211e1e" },
  dark: { background: "#191515", foreground: "#d4d4d4" },
}

const SELECTION_ALPHA: Record<Mode, number> = { light: 0.2, dark: 0.25 }

function hexColor(value: string): string | undefined {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value
  return /^#[0-9a-f]{8}$/i.test(value) ? value.slice(0, 7) : undefined
}

function withAlpha(hex: string, alpha: number): string {
  const digits =
    hex.length === 4
      ? hex
          .slice(1)
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex.slice(1, 7)
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function currentMode(): Mode {
  const declared = document.documentElement.dataset.colorScheme
  if (declared === "dark" || declared === "light") return declared
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function terminalColors(): TerminalColors {
  const mode = currentMode()
  const seeds = SEEDS[mode]
  const background = hexColor(cssVariable("--v2-background-bg-base")) ?? seeds.background
  const foreground = hexColor(cssVariable("--v2-text-text-base")) ?? seeds.foreground
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: withAlpha(foreground, SELECTION_ALPHA[mode]),
  }
}

export function monoFontFamily(): string {
  return cssVariable("--font-family-terminal") || TERMINAL_FONT_FAMILY
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
