import { resolveThemeVariant, withAlpha, type ColorValue, type DesktopTheme, type HexColor } from "@opencode-ai/ui/theme"
import { isHexColor } from "@opencode-ai/ui/theme/color"
import type { TerminalColors } from "@/features/terminal/core/backend/types"

/**
 * Terminal colours, resolved from the active theme.
 *
 * Extracted from `terminal.tsx` because that file is allowlisted at a size
 * ceiling it had grown past, and this is the largest genuinely PURE block in it:
 * two theme values in, four colours out, no backend and no reactive graph. It is
 * also the part most worth testing on its own, which the component's size made
 * awkward.
 */

/** Selection highlight opacity over the terminal's own background, per mode. */
const SELECTION_ALPHA: Record<"light" | "dark", number> = { light: 0.2, dark: 0.25 }

/**
 * The hex seeds the built-in colours derive from. Kept as `HexColor` rather
 * than folded into `DEFAULT_TERMINAL_COLORS` because `withAlpha` needs a real
 * hex, and `TerminalColors` is the widened xterm-facing shape.
 */
const DEFAULT_SEEDS: Record<"light" | "dark", { background: HexColor; foreground: HexColor }> = {
  light: { background: "#fcfcfc", foreground: "#211e1e" },
  dark: { background: "#191515", foreground: "#d4d4d4" },
}

/** The four colours xterm needs, from a background and a foreground. */
function terminalColorsFrom(mode: "light" | "dark", background: ColorValue, foreground: ColorValue): TerminalColors {
  // Selection needs to read as a highlight over the terminal's own background, so
  // it is the text colour at low alpha rather than a separate token.
  const base = isHexColor(foreground) ? foreground : DEFAULT_SEEDS[mode].foreground
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: withAlpha(base, SELECTION_ALPHA[mode]),
  }
}

export const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: terminalColorsFrom("light", DEFAULT_SEEDS.light.background, DEFAULT_SEEDS.light.foreground),
  dark: terminalColorsFrom("dark", DEFAULT_SEEDS.dark.background, DEFAULT_SEEDS.dark.foreground),
}

/**
 * Falls back to the built-in pair whenever the theme cannot supply BOTH a seed
 * set and a palette — a partially-defined theme would otherwise resolve to
 * transparent or undefined colours, which reads as a broken terminal rather than
 * a broken theme.
 */
export function resolveTerminalColors(input: { mode: "light" | "dark"; theme?: DesktopTheme }): TerminalColors {
  const variant = input.mode === "dark" ? input.theme?.dark : input.theme?.light
  if (!variant || (!variant.seeds && !variant.palette)) return DEFAULT_TERMINAL_COLORS[input.mode]
  const resolved = resolveThemeVariant(variant, input.mode === "dark")
  return terminalColorsFrom(
    input.mode,
    resolved["background-stronger"] ?? DEFAULT_SEEDS[input.mode].background,
    resolved["text-stronger"] ?? DEFAULT_SEEDS[input.mode].foreground,
  )
}
