import type { ITerminalOptions } from "@xterm/xterm"
import { TERMINAL_SCROLLBACK_ROWS } from "@claxedo/workspace-runtime/client"

export const TERMINAL_FONT_FAMILY = [
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

type TerminalOptions = ITerminalOptions & {
  scrollbar?: { showScrollbar: boolean; width: number }
}

export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: TERMINAL_FONT_FAMILY,
  allowProposedApi: true,
  scrollback: TERMINAL_SCROLLBACK_ROWS,
  macOptionIsMeta: false,
  cursorStyle: "bar",
  cursorInactiveStyle: "outline",
  fastScrollSensitivity: 5,
  screenReaderMode: false,
  scrollbar: { showScrollbar: true, width: 6 },
} satisfies TerminalOptions

export const SETTLE_MS = 80
export const MIN_CONTAINER_PX = 10
