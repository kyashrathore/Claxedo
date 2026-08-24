import { resolveThemeVariant, withAlpha, type HexColor } from "@opencode-ai/ui/theme"
/** The four colours the terminal backend needs. */
export type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

/**
 * Terminal colours, resolved from the active theme.
 *
 * Extracted from `terminal.tsx` because that file is allowlisted at a size
 * ceiling it had grown past, and this is the largest genuinely PURE block in it:
 * two theme values in, four colours out, no backend and no reactive graph. It is
 * also the part most worth testing on its own, which the component's size made
 * awkward.
 */
export const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

/**
 * Falls back to the built-in pair whenever the theme cannot supply BOTH a seed
 * set and a palette — a partially-defined theme would otherwise resolve to
 * transparent or undefined colours, which reads as a broken terminal rather than
 * a broken theme.
 */
export function resolveTerminalColors(input: {
  mode: "light" | "dark"
  theme?: { light?: unknown; dark?: unknown }
}): TerminalColors {
  const fallback = DEFAULT_TERMINAL_COLORS[input.mode]
  const variant = (input.mode === "dark" ? input.theme?.dark : input.theme?.light) as
    { seeds?: unknown; palette?: unknown } | undefined
  if (!input.theme || (!variant?.seeds && !variant?.palette)) return fallback
  const resolved = resolveThemeVariant(variant as never, input.mode === "dark")
  const text = resolved["text-stronger"] ?? fallback.foreground
  const background = resolved["background-stronger"] ?? fallback.background
  // Selection needs to read as a highlight over the terminal's own background, so
  // it is the text colour at low alpha rather than a separate token.
  const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
  return {
    background,
    foreground: text,
    cursor: text,
    selectionBackground: withAlpha(base, input.mode === "dark" ? 0.25 : 0.2),
  }
}
