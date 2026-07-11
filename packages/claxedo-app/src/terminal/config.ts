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

type TerminalOptions = ITerminalOptions & {
  // xterm v6 supports this option before its public typings expose it.
  scrollbar?: { showScrollbar: boolean }
}

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
} satisfies TerminalOptions

// Resize coordinator settings.
export const SETTLE_MS = 80
export const MIN_CONTAINER_PX = 10

// ============================================================================
// Screen-reader (accessibility) mode
// ============================================================================
//
// xterm's `screenReaderMode` mounts an accessible DOM layer that mirrors every
// cell for assistive tech. It carries a real paint cost, so TERMINAL_OPTIONS
// leaves it off by default. A screen-reader user (or a settings toggle) can
// opt in via the persisted preference below; createTerminalInstance seeds each
// new terminal from it, and TerminalBackend.setScreenReaderMode flips it live
// on an already-mounted terminal. Full @xterm/addon-a11y wiring lands in WP-C1
// on top of this toggle.

const SCREEN_READER_MODE_KEY = "claxedo.terminal.screen-reader-mode"

/** Whether the user has opted the terminal into accessible/screen-reader mode. */
export function getScreenReaderModePreference(): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem(SCREEN_READER_MODE_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * Persist the terminal screen-reader-mode preference. This is the exported hook
 * the settings UI surfaces; it only records intent — callers still flip live
 * terminals through TerminalBackend.setScreenReaderMode.
 */
export function setScreenReaderModePreference(enabled: boolean): void {
  if (typeof localStorage === "undefined") return
  try {
    if (enabled) {
      localStorage.setItem(SCREEN_READER_MODE_KEY, "1")
    } else {
      localStorage.removeItem(SCREEN_READER_MODE_KEY)
    }
  } catch {
    // Storage disabled (private mode / quota) — preference is best-effort.
  }
}
