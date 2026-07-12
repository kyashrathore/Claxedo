import type { Terminal as XTerm } from "@xterm/xterm"

type KeyboardHandlerTerminal = Pick<XTerm, "attachCustomKeyEventHandler">

// ============================================================================
// Keyboard Handler
// ============================================================================

export function setupKeyboardHandler(
  xterm: KeyboardHandlerTerminal,
  options: {
    onShiftEnter?: () => void
    onClear?: () => void
    onWrite?: (data: string) => void
    onSplitVertical?: () => void
    onSplitHorizontal?: () => void
  } = {},
): () => void {
  const handler = (event: KeyboardEvent): boolean => {
    const key = event.key.toLowerCase()

    // Platform-aware action modifier: Cmd on Mac, Ctrl on Linux/Windows
    const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "")
    const actionMod = isMac ? event.metaKey : event.ctrlKey

    // Shift+Enter: Send ESC+CR for line continuation
    if (key === "enter" && event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (event.type === "keydown" && options.onShiftEnter) {
        options.onShiftEnter()
      }
      return false
    }

    // Cmd/Ctrl+Backspace: Clear line (Ctrl+U + left arrow)
    if (key === "backspace" && actionMod) {
      if (event.type === "keydown" && options.onWrite) {
        options.onWrite("\x15\x1b[D")
      }
      return false
    }

    // Option+Arrow: word navigation (Mac only — altKey = Option)
    if (isMac && event.altKey && !event.metaKey && !event.ctrlKey) {
      if (key === "arrowleft") {
        if (event.type === "keydown" && options.onWrite) options.onWrite("\x1bb")
        return false
      }
      if (key === "arrowright") {
        if (event.type === "keydown" && options.onWrite) options.onWrite("\x1bf")
        return false
      }
    }

    // Cmd/Ctrl+Left: Beginning of line (Ctrl+A)
    if (key === "arrowleft" && actionMod) {
      if (event.type === "keydown" && options.onWrite) {
        options.onWrite("\x01")
      }
      return false
    }

    // Cmd/Ctrl+Right: End of line (Ctrl+E)
    if (key === "arrowright" && actionMod) {
      if (event.type === "keydown" && options.onWrite) {
        options.onWrite("\x05")
      }
      return false
    }

    // Ctrl+C: SIGINT. Handle explicitly so browser copy/default handling cannot
    // steal the chord before xterm emits ETX.
    if (key === "c" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.type === "keydown" && options.onWrite) {
        options.onWrite("\x03")
      }
      return false
    }

    // Cmd+D: Split vertical (left/right)
    if (key === "d" && event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      if (event.type === "keydown" && options.onSplitVertical) {
        event.preventDefault()
        event.stopPropagation()
        options.onSplitVertical()
      }
      return false
    }

    // Cmd+Shift+D: Split horizontal (top/bottom)
    if (key === "d" && event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey) {
      if (event.type === "keydown" && options.onSplitHorizontal) {
        event.preventDefault()
        event.stopPropagation()
        options.onSplitHorizontal()
      }
      return false
    }

    // Allow Ctrl+` for parent app toggle
    if (event.ctrlKey && key === "`") {
      return true
    }

    return true
  }

  xterm.attachCustomKeyEventHandler(handler)
  return () => xterm.attachCustomKeyEventHandler(() => true)
}
