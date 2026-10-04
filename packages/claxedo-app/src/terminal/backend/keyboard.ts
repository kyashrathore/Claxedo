import type { Terminal as XTerm } from "@xterm/xterm"

type KeyboardTerminal = Pick<XTerm, "attachCustomKeyEventHandler">

export type KeyboardOptions = {
  readonly onShiftEnter?: () => void
  readonly onWrite?: (data: string) => void
  readonly onSplitVertical?: () => void
  readonly onSplitHorizontal?: () => void
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "")
}

function chordWrite(event: KeyboardEvent, options: KeyboardOptions, data: string): false {
  if (event.type === "keydown") options.onWrite?.(data)
  return false
}

function splitChord(event: KeyboardEvent, run: (() => void) | undefined): false {
  if (event.type === "keydown" && run) {
    event.preventDefault()
    event.stopPropagation()
    run()
  }
  return false
}

function handleKey(event: KeyboardEvent, options: KeyboardOptions): boolean {
  const key = event.key.toLowerCase()
  const mac = isMacPlatform()
  const action = mac ? event.metaKey : event.ctrlKey
  if (key === "enter" && event.shiftKey && !event.metaKey && !event.ctrlKey) {
    if (event.type === "keydown") options.onShiftEnter?.()
    return false
  }
  if (key === "backspace" && action) return chordWrite(event, options, "\x15\x1b[D")
  if (mac && event.altKey && !event.metaKey && !event.ctrlKey) {
    if (key === "arrowleft") return chordWrite(event, options, "\x1bb")
    if (key === "arrowright") return chordWrite(event, options, "\x1bf")
  }
  if (key === "arrowleft" && action) return chordWrite(event, options, "\x01")
  if (key === "arrowright" && action) return chordWrite(event, options, "\x05")
  if (key === "c" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return chordWrite(event, options, "\x03")
  }
  if (key === "d" && event.metaKey && !event.ctrlKey && !event.altKey) {
    return splitChord(event, event.shiftKey ? options.onSplitHorizontal : options.onSplitVertical)
  }
  return true
}

export function setupKeyboard(xterm: KeyboardTerminal, options: KeyboardOptions = {}): () => void {
  xterm.attachCustomKeyEventHandler((event) => handleKey(event, options))
  return () => xterm.attachCustomKeyEventHandler(() => true)
}
