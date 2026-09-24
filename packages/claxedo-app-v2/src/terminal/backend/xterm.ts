import "@xterm/xterm/css/xterm.css"
import "./terminal.css"
import { objectProperty } from "./reflect"
import { createTerminalInstance, scrollToBottom } from "./renderer"
import { setupKeyboard } from "./keyboard"
import { setupCopy, setupPaste } from "./clipboard"
import { setupDrop } from "./drop"
import { setupWheel } from "./wheel"
import { setupResizeHandlers } from "./resize-handlers"
import { createModeTracker } from "./modes"
import { installInputModeReclaimer } from "./input-mode-reclaimer"
import { createParserGate, gatedWrite } from "./parser-gate"
import { createCheckpointRestorer } from "./checkpoint"
import type { CreateBackend, Disposer, TerminalBackend, TerminalBackendOptions, TerminalSize } from "./types"

type Listeners = {
  data: Set<(data: string) => void>
  key: Set<(event: { key: string }) => void>
  resize: Set<(size: TerminalSize) => void>
}

function parsedColors(xterm: unknown): { foreground: number; background: number } {
  const colors = objectProperty(objectProperty(objectProperty(xterm, "_core"), "_themeService"), "colors")
  const foreground = objectProperty(objectProperty(colors, "foreground"), "rgba")
  const background = objectProperty(objectProperty(colors, "background"), "rgba")
  if (typeof foreground !== "number" || typeof background !== "number") {
    throw new Error("The terminal's parsed default colors are unavailable")
  }
  return { foreground, background }
}

function listen<T>(set: Set<T>, fn: T): Disposer {
  set.add(fn)
  return () => set.delete(fn)
}

export const createBackend: CreateBackend = async (container, options) => {
  const instance = createTerminalInstance(container, {
    theme: options.theme,
    fontFamily: options.fontFamily,
    renderers: options.renderers,
    onFileLinkClick: options.onFileLinkClick,
    onUrlClick: (event, url) => options.onUrlClick?.(event, url),
  })
  const { xterm, fitAddon, serializeAddon } = instance
  const listeners: Listeners = { data: new Set(), key: new Set(), resize: new Set() }
  const emitData = (data: string) => {
    for (const fn of listeners.data) fn(data)
  }
  const tracker = createModeTracker(xterm)
  const parserGate = createParserGate()
  const write = gatedWrite(parserGate, xterm.write.bind(xterm))
  let disposed = false
  const restore = createCheckpointRestorer({ xterm, write, onReset: tracker.reset, disposed: () => disposed })
  const resize = setupResizeHandlers({
    container,
    xterm,
    fitAddon,
    renderer: instance.renderer,
    parserGate,
    onResize: (cols, rows) => {
      for (const fn of listeners.resize) fn({ cols, rows })
    },
  })
  const bracketedPaste = () => tracker.modes().bracketedPaste
  const cleanups: Disposer[] = [
    instance.cleanup,
    () => xterm.dispose(),
    tracker.dispose,
    installInputModeReclaimer(xterm),
    setupWheel(container, tracker, emitData),
    setupKeyboard(xterm, {
      onShiftEnter: () => emitData("\x1b\r"),
      onWrite: emitData,
      onSplitVertical: options.onSplitVertical,
      onSplitHorizontal: options.onSplitHorizontal,
    }),
    setupPaste(xterm, { onWrite: emitData, bracketedPaste }),
    setupCopy(xterm),
    setupDrop(container, { image: options.image, onWrite: emitData, bracketedPaste }),
    resize.cleanup,
    xterm.onData(emitData).dispose,
    xterm.onKey((event) => {
      for (const fn of listeners.key) fn({ key: event.key })
    }).dispose,
  ]
  const textarea = xterm.textarea
  if (textarea) {
    const onFocus = () => (xterm.options.cursorBlink = true)
    const onBlur = () => (xterm.options.cursorBlink = false)
    textarea.addEventListener("focus", onFocus)
    textarea.addEventListener("blur", onBlur)
    cleanups.push(() => {
      textarea.removeEventListener("focus", onFocus)
      textarea.removeEventListener("blur", onBlur)
    })
  }

  const backend: TerminalBackend = {
    get cols() {
      return xterm.cols
    },
    get rows() {
      return xterm.rows
    },
    get textarea() {
      return xterm.textarea ?? null
    },
    get element() {
      return xterm.element ?? null
    },
    write: (data, callback) => write(data, callback),
    restoreCheckpoint: restore,
    onData: (fn) => listen(listeners.data, fn),
    onKey: (fn) => listen(listeners.key, fn),
    onResize: (fn) => listen(listeners.resize, fn),
    setTheme: (theme) => (xterm.options.theme = theme),
    getDefaultColors: () => parsedColors(xterm),
    setFontFamily: (font) => (xterm.options.fontFamily = font),
    setCursorBlink: (blink) => (xterm.options.cursorBlink = blink),
    setScreenReaderMode: (enabled) => (xterm.options.screenReaderMode = enabled),
    focus: () => xterm.focus(),
    getSelection: () => xterm.getSelection(),
    hasSelection: () => xterm.hasSelection(),
    scrollToLine: (line) => xterm.scrollToLine(line),
    scrollToBottom: () => scrollToBottom(xterm),
    getViewportY: () => xterm.buffer.active.viewportY,
    isAtBottom: () => xterm.buffer.active.viewportY >= xterm.buffer.active.baseY,
    resize: (cols, rows) => xterm.resize(cols, rows),
    fit: () => resize.coordinator.flush(),
    refresh: (start, end) => xterm.refresh(start, end),
    serialize: (serializeOptions) => serializeAddon.serialize(serializeOptions),
    isAltScreen: () => tracker.modes().alternateScreen,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      listeners.data.clear()
      listeners.key.clear()
      listeners.resize.clear()
    },
  }
  return backend
}
