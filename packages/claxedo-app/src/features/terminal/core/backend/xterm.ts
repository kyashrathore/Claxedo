import { SerializeAddon } from "@xterm/addon-serialize"
import "@xterm/xterm/css/xterm.css"
import "../terminal.css"
import { createTerminalInstance, scrollToBottom } from "./renderer"
import { setupKeyboardHandler } from "./keyboard"
import { setupPasteHandler, setupCopyHandler, setupDropHandler } from "./clipboard"
import { setupResizeHandlers } from "./resize-handlers"
import { createModeScanner } from "../mode-scan"
import { createQuerySuppressor } from "../query-suppression"
import type { TerminalBackend, TerminalBackendOptions, Disposable, CreateBackendFn } from "./types"
import { cancelParserIdleWork, createParserIdleGate, wrapWrite } from "../parser-idle-gate"
import { installInputModeReclaimer } from "./input-mode-reclaimer"

export const createBackend: CreateBackendFn = async (
  container: HTMLDivElement,
  options: TerminalBackendOptions,
): Promise<TerminalBackend> => {
  const instance = createTerminalInstance(container, {
    initialTheme: options.theme,
    fontFamily: options.fontFamily,
    onFileLinkClick: options.onFileLinkClick,
    onUrlClick: options.onUrlClick,
  })

  const { xterm, fitAddon } = instance
  // Cleanups are reversed before execution. Keep xterm disposal before renderer
  // disposal so xterm addons can deregister and refresh while a renderer still
  // exists.
  const cleanups: VoidFunction[] = [instance.cleanup, () => xterm.dispose()]
  const updateScrollbarState = () => {
    container.toggleAttribute("data-terminal-scrollbar", xterm.buffer.active.baseY > 0)
  }

  // Load serialize addon
  const serializeAddon = new SerializeAddon()
  xterm.loadAddon(serializeAddon)

  // Load search addon (async, best-effort)
  import("@xterm/addon-search")
    .then(({ SearchAddon }) => {
      const searchAddon = new SearchAddon()
      xterm.loadAddon(searchAddon)
    })
    .catch(() => {})

  // Track bracketed paste mode across split writes.
  const mode = createModeScanner()
  const suppress = createQuerySuppressor()

  // Disarm mouse / focus / kitty-keyboard modes that a TUI killed uncleanly
  // left armed in the shell that reclaimed the pty. Installed on every
  // terminal; it only acts at a prompt, and only on modes a TUI armed.
  const reclaimer = installInputModeReclaimer(xterm)
  cleanups.push(() => reclaimer.dispose())
  // Count in-flight writes so a fit can wait out a paused async parser handler
  // instead of re-entering the parser and permanently FAILing it. Wrapping here
  // (rather than at each call site) means EVERY write is counted, including the
  // buffer restore and the mode preamble.
  const parserGate = createParserIdleGate()
  const originalWrite = wrapWrite(parserGate, xterm.write.bind(xterm) as (
    data: string | Uint8Array,
    callback?: () => void,
  ) => void)

  // Data/key listeners managed externally
  let dataListeners: Array<(data: string) => void> = []
  let keyListeners: Array<(e: { key: string }) => void> = []
  let resizeListeners: Array<(size: { cols: number; rows: number }) => void> = []

  // Setup keyboard handler with a write function that goes through onData listeners
  const handleWrite = (data: string) => {
    for (const fn of dataListeners) fn(data)
  }

  // Alternate scroll mode (DECSET 1007): when enabled, real terminals map
  // wheel/trackpad scroll to Up/Down keypresses instead of scrollback.
  //
  // Additionally, some TUIs don't enable 1007 but still want scroll gestures
  // to stay inside the app (not scroll the surrounding page). In alt-screen,
  // we provide a conservative fallback to PageUp/PageDown when mouse tracking
  // is disabled.
  const setupWheel = () => {
    const el = container
    let acc = 0
    const stepPx = 40
    const maxBurst = 12

    const seq = (dir: 1 | -1) => {
      const appCursor = mode.modes().applicationCursorKeys
      if (dir < 0) return appCursor ? "\x1bOA" : "\x1b[A"
      return appCursor ? "\x1bOB" : "\x1b[B"
    }
    const page = (dir: 1 | -1) => {
      if (dir < 0) return "\x1b[5~"
      return "\x1b[6~"
    }

    const onWheel = (event: WheelEvent) => {
      const m = mode.modes()
      if (!m.alternateScroll && !m.alternateScreen) return

      // Prevent the surrounding page/panels from scrolling when a fullscreen
      // TUI is running. Don't stop propagation so xterm can still handle mouse
      // wheel reporting when mouse tracking is enabled.
      event.preventDefault()

      const mouse =
        m.mouseTrackingX10 ||
        m.mouseTrackingNormal ||
        m.mouseTrackingHighlight ||
        m.mouseTrackingButtonEvent ||
        m.mouseTrackingAnyEvent ||
        m.mouseUtf8 ||
        m.mouseSgr
      if (mouse) return
      if (!m.alternateScroll && !m.alternateScreen) return

      const dy = event.deltaY
      if (!Number.isFinite(dy) || dy === 0) return

      // Normalize delta across devices. deltaMode=1 is "lines", 2 is "pages".
      const unit = event.deltaMode === 1 ? 12 : event.deltaMode === 2 ? 96 : 1
      acc += dy * unit

      const count = Math.min(maxBurst, Math.floor(Math.abs(acc) / stepPx))
      if (count <= 0) return

      const dir = acc < 0 ? -1 : 1
      acc -= dir * count * stepPx

      if (m.alternateScroll) {
        handleWrite(seq(dir).repeat(count))
        return
      }

      // Alt-screen fallback (no 1007): prefer PageUp/PageDown. Arrow keys tend to
      // move focus rather than scroll in many TUIs.
      handleWrite(page(dir).repeat(Math.min(6, count)))
    }

    el.addEventListener("wheel", onWheel, { passive: false, capture: true })
    return () => el.removeEventListener("wheel", onWheel, { capture: true })
  }

  cleanups.push(setupWheel())

  const cleanupKeyboard = setupKeyboardHandler(xterm, {
    onShiftEnter: () => handleWrite("\x1b\r"),
    onWrite: handleWrite,
    onSplitVertical: options.onSplitVertical,
    onSplitHorizontal: options.onSplitHorizontal,
  })
  cleanups.push(cleanupKeyboard)

  const cleanupPaste = setupPasteHandler(xterm, {
    onWrite: handleWrite,
    isBracketedPasteEnabled: () => mode.bracketed(),
  })
  cleanups.push(cleanupPaste)

  const cleanupCopy = setupCopyHandler(xterm)
  cleanups.push(cleanupCopy)

  const cleanupDrop = setupDropHandler(xterm, container, {
    image: options.image,
    onWrite: handleWrite,
    isBracketedPasteEnabled: () => mode.bracketed(),
  })
  cleanups.push(cleanupDrop)

  // Toggle cursor blink on focus/blur.
  const textarea = xterm.textarea
  if (textarea) {
    const onFocus = () => {
      xterm.options.cursorBlink = true
    }
    const onBlur = () => {
      xterm.options.cursorBlink = false
    }
    textarea.addEventListener("focus", onFocus)
    textarea.addEventListener("blur", onBlur)
    cleanups.push(() => {
      textarea.removeEventListener("focus", onFocus)
      textarea.removeEventListener("blur", onBlur)
    })
  }

  // Setup resize handlers (includes visibilitychange + mount fits)
  const resizeHandlers = setupResizeHandlers(
    container,
    xterm,
    fitAddon,
    (cols, rows) => {
      for (const fn of resizeListeners) fn({ cols, rows })
    },
    instance.renderer,
    parserGate,
  )
  cleanups.push(resizeHandlers.cleanup)
  // Drop any fit parked behind a write that will never complete now.
  cleanups.push(() => cancelParserIdleWork(parserGate))

  // Wire xterm's native onData (user typing) into our data listeners
  const xtermOnData = xterm.onData((data) => {
    for (const fn of dataListeners) fn(data)
  })
  cleanups.push(() => xtermOnData.dispose())

  // Wire xterm's native onKey into our key listeners
  const xtermOnKey = xterm.onKey((e) => {
    for (const fn of keyListeners) fn({ key: e.key })
  })
  cleanups.push(() => xtermOnKey.dispose())

  const xtermOnWriteParsed = xterm.onWriteParsed(updateScrollbarState)
  const xtermOnScroll = xterm.onScroll(updateScrollbarState)
  const xtermOnResize = xterm.onResize(updateScrollbarState)
  cleanups.push(() => {
    xtermOnWriteParsed.dispose()
    xtermOnScroll.dispose()
    xtermOnResize.dispose()
    container.removeAttribute("data-terminal-scrollbar")
  })
  updateScrollbarState()

  let disposed = false

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

    write(data: string, callback?: () => void) {
      const filtered = suppress.scan(data)
      mode.scan(filtered)

      if (!filtered) {
        callback?.()
        return
      }
      if (callback) {
        originalWrite(filtered, callback)
      } else {
        originalWrite(filtered)
      }
    },

    onData(fn: (data: string) => void): Disposable {
      dataListeners.push(fn)
      return {
        dispose() {
          dataListeners = dataListeners.filter((f) => f !== fn)
        },
      }
    },

    onKey(fn: (e: { key: string }) => void): Disposable {
      keyListeners.push(fn)
      return {
        dispose() {
          keyListeners = keyListeners.filter((f) => f !== fn)
        },
      }
    },

    onResize(fn: (size: { cols: number; rows: number }) => void): Disposable {
      resizeListeners.push(fn)
      return {
        dispose() {
          resizeListeners = resizeListeners.filter((f) => f !== fn)
        },
      }
    },

    setTheme(theme) {
      xterm.options.theme = theme
    },

    setFontFamily(font) {
      xterm.options.fontFamily = font
    },

    setCursorBlink(blink) {
      xterm.options.cursorBlink = blink
    },

    setScreenReaderMode(enabled) {
      xterm.options.screenReaderMode = enabled
    },

    focus() {
      xterm.focus()
      setTimeout(() => xterm.textarea?.focus(), 0)
    },

    getSelection() {
      return xterm.getSelection()
    },

    hasSelection() {
      return xterm.hasSelection()
    },

    scrollToLine(line) {
      xterm.scrollToLine(line)
    },

    scrollToBottom() {
      scrollToBottom(xterm)
    },

    getViewportY() {
      return xterm.buffer.active.viewportY
    },

    isAtBottom() {
      const buffer = xterm.buffer.active
      return buffer.viewportY >= buffer.baseY
    },

    resize(cols, rows) {
      xterm.resize(cols, rows)
    },

    fit() {
      fitAddon.fit()
    },

    refresh(start, end) {
      xterm.refresh(start, end)
    },

    flushResize() {
      resizeHandlers.coordinator.flush()
    },

    serialize(options) {
      return serializeAddon.serialize(options)
    },

    rehydrateSequences() {
      return mode.rehydrateSequences()
    },

    isAltScreen() {
      try {
        const active = xterm.buffer.active
        if ("type" in active) return active.type === "alternate"
      } catch {}
      return mode.modes().alternateScreen
    },

    dispose() {
      if (disposed) return
      disposed = true
      const fns = cleanups.splice(0).reverse()
      for (const fn of fns) {
        try {
          fn()
        } catch {}
      }
      dataListeners = []
      keyListeners = []
      resizeListeners = []
    },
  }

  return backend
}
