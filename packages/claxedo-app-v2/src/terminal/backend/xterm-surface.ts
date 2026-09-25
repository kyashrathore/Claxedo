import type { Terminal as XTerm } from "@xterm/xterm"
import { objectProperty } from "./reflect"
import { scrollToBottom } from "./renderer"
import type { TerminalBackend } from "./types"

type AppearanceSurface = Pick<
  TerminalBackend,
  "setTheme" | "getDefaultColors" | "setFontFamily" | "setCursorBlink" | "setScreenReaderMode"
>

type ViewportSurface = Pick<
  TerminalBackend,
  "focus" | "getSelection" | "hasSelection" | "scrollToLine" | "scrollToBottom" | "getViewportY" | "isAtBottom" | "resize" | "refresh"
>

function parsedColors(xterm: unknown): { foreground: number; background: number } {
  const colors = objectProperty(objectProperty(objectProperty(xterm, "_core"), "_themeService"), "colors")
  const foreground = objectProperty(objectProperty(colors, "foreground"), "rgba")
  const background = objectProperty(objectProperty(colors, "background"), "rgba")
  if (typeof foreground !== "number" || typeof background !== "number") {
    throw new Error("The terminal's parsed default colors are unavailable")
  }
  return { foreground, background }
}

export function appearanceSurface(xterm: XTerm): AppearanceSurface {
  return {
    setTheme: (theme) => (xterm.options.theme = theme),
    getDefaultColors: () => parsedColors(xterm),
    setFontFamily: (font) => (xterm.options.fontFamily = font),
    setCursorBlink: (blink) => (xterm.options.cursorBlink = blink),
    setScreenReaderMode: (enabled) => (xterm.options.screenReaderMode = enabled),
  }
}

export function viewportSurface(xterm: XTerm): ViewportSurface {
  return {
    focus: () => xterm.focus(),
    getSelection: () => xterm.getSelection(),
    hasSelection: () => xterm.hasSelection(),
    scrollToLine: (line) => xterm.scrollToLine(line),
    scrollToBottom: () => scrollToBottom(xterm),
    getViewportY: () => xterm.buffer.active.viewportY,
    isAtBottom: () => xterm.buffer.active.viewportY >= xterm.buffer.active.baseY,
    resize: (cols, rows) => xterm.resize(cols, rows),
    refresh: (start, end) => xterm.refresh(start, end),
  }
}
