import type { ITerminalOptions } from "@xterm/xterm"

// Font stack prioritizing Nerd Fonts for shell theme compatibility
const TERMINAL_FONT_FAMILY = [
  "MesloLGM Nerd Font",
  "MesloLGS NF",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  "JetBrainsMono Nerd Font",
  "Menlo",
  "Monaco",
  "SF Mono",
  "monospace",
].join(", ")

// Cast allows xterm proposed/undocumented options (e.g. scrollbar) without TS errors
export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: TERMINAL_FONT_FAMILY,
  allowProposedApi: true,
  scrollback: 5000,
  macOptionIsMeta: false,
  cursorStyle: "bar",
  cursorInactiveStyle: "outline",
  fastScrollSensitivity: 5,
  screenReaderMode: false,
  scrollbar: { showScrollbar: true },
} as ITerminalOptions

// Resize coordinator settings (Ghostty-style settle gate)
export const SETTLE_MS = 80
export const MIN_CONTAINER_PX = 10
