import "@xterm/xterm/css/xterm.css"
import "./terminal.css"
import type { Terminal as XTerm } from "@xterm/xterm"
import { createTerminalInstance, type TerminalInstance, type TerminalInstanceOptions } from "./renderer"
import { setupResizeHandlers } from "./resize-handlers"
import { createModeTracker, type ModeTracker } from "./modes"
import { createParserGate, gatedWrite } from "./parser-gate"
import { createCheckpointRestorer } from "./checkpoint"
import { createListeners, type BackendListeners } from "./listeners"
import { installInput } from "./input"
import { blinkWhileFocused } from "./cursor-blink"
import { appearanceSurface, viewportSurface } from "./xterm-surface"
import type { Disposer } from "@/shell"
import type { CreateBackend, TerminalBackend, TerminalBackendOptions } from "./types"

type BackendParts = {
  readonly xterm: XTerm
  readonly serializeAddon: TerminalInstance["serializeAddon"]
  readonly write: TerminalBackend["write"]
  readonly restore: TerminalBackend["restoreCheckpoint"]
  readonly listeners: BackendListeners
  readonly tracker: ModeTracker
  readonly fit: () => void
  readonly dispose: () => void
}

function instanceOptions(options: TerminalBackendOptions): TerminalInstanceOptions {
  return {
    theme: options.theme,
    fontFamily: options.fontFamily,
    screenReaderMode: options.screenReaderMode,
    renderers: options.renderers,
    onFileLinkClick: options.onFileLinkClick,
    onUrlClick: (event, url) => options.onUrlClick?.(event, url),
  }
}

function backendOf(parts: BackendParts): TerminalBackend {
  const { xterm, listeners } = parts
  return {
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
    ...appearanceSurface(xterm),
    ...viewportSurface(xterm),
    write: (data, callback) => parts.write(data, callback),
    restoreCheckpoint: parts.restore,
    onData: listeners.onData,
    onKey: listeners.onKey,
    onResize: listeners.onResize,
    fit: parts.fit,
    serialize: (serializeOptions) => parts.serializeAddon.serialize(serializeOptions),
    isAltScreen: () => parts.tracker.modes().alternateScreen,
    dispose: parts.dispose,
  }
}

function disposalOrder(input: {
  container: HTMLDivElement
  instance: TerminalInstance
  options: TerminalBackendOptions
  tracker: ModeTracker
  listeners: BackendListeners
  resizeCleanup: () => void
}): Disposer[] {
  const { container, instance, options, tracker, listeners } = input
  const { xterm } = instance
  const cleanups: Disposer[] = [
    instance.cleanup,
    () => xterm.dispose(),
    tracker.dispose,
    ...installInput({ container, xterm, options, tracker, emitData: listeners.emitData }),
    input.resizeCleanup,
    xterm.onData(listeners.emitData).dispose,
    xterm.onKey((event) => listeners.emitKey(event.key)).dispose,
  ]
  const blink = blinkWhileFocused(xterm)
  if (blink) cleanups.push(blink)
  return cleanups
}

export const createBackend: CreateBackend = async (container, options) => {
  const instance = createTerminalInstance(container, instanceOptions(options))
  const { xterm, fitAddon, serializeAddon } = instance
  const listeners = createListeners()
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
    onResize: listeners.emitResize,
  })
  const cleanups = disposalOrder({ container, instance, options, tracker, listeners, resizeCleanup: resize.cleanup })

  return backendOf({
    xterm,
    serializeAddon,
    write,
    restore,
    listeners,
    tracker,
    fit: () => resize.coordinator.flush(),
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      listeners.clear()
    },
  })
}
