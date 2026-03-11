import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { ClipboardAddon } from "@xterm/addon-clipboard"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { TERMINAL_OPTIONS, MIN_CONTAINER_PX } from "./config"
import { UrlLinkProvider, FilePathLinkProvider } from "./link-providers"
import { createResizeCoordinator, type ResizeCoordinator } from "./resize-coordinator"
import type { ITheme, ITerminalAddon } from "@xterm/xterm"
import { createDebugLogger } from "../utils/debug"

const fitLogger = createDebugLogger("terminal.fit", "terminal:fit", {
  legacyKey: "opencode.debug.terminal",
})

function fitDebug() {
  return fitLogger.enabled(2)
}

function flog(...args: unknown[]) {
  if (!fitDebug()) return
  fitLogger.log(...args)
}

// ============================================================================
// Scroll Utilities
// ============================================================================

/**
 * Scroll terminal to bottom using DOM viewport directly.
 * This is more reliable than xterm's internal scrollToBottom() method.
 */
export function scrollToBottom(terminal: XTerm, behavior: ScrollBehavior = "instant"): void {
  const viewport = terminal.element?.querySelector(".xterm-viewport")
  if (viewport) {
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    })
  } else {
    terminal.scrollToBottom()
  }
}

// ============================================================================
// Types
// ============================================================================

export interface TerminalRendererRef {
  current: {
    kind: "webgl" | "dom"
    dispose: () => void
    clearTextureAtlas?: () => void
  }
}

export interface CreateTerminalResult {
  xterm: XTerm
  fitAddon: FitAddon
  renderer: TerminalRendererRef
  cleanup: () => void
}

// ============================================================================
// Renderer Loading
// ============================================================================

function loadRenderer(xterm: XTerm): TerminalRendererRef["current"] {
  const ref: TerminalRendererRef["current"] = {
    kind: "dom",
    dispose: () => {},
    clearTextureAtlas: undefined,
  }

  // Allow an escape hatch for debugging / problematic GPUs:
  // - "dom": don't attempt WebGL
  // - "webgl": attempt WebGL (still falls back if unsupported)
  // - unset/other: attempt WebGL
  const pref = (() => {
    if (typeof localStorage === "undefined") return ""
    try {
      return localStorage.getItem("opencode.terminal.renderer") ?? ""
    } catch {
      return ""
    }
  })()
  if (pref === "dom") return ref

  const supported = (() => {
    if (typeof document === "undefined") return false
    const el = document.createElement("canvas")
    if (typeof el.getContext !== "function") return false
    try {
      // WebGL renderer can work in environments without WebGL2 (e.g. older
      // browsers/GPU configs) so accept WebGL1 as "supported" too.
      return !!(el.getContext("webgl2") || el.getContext("webgl"))
    } catch {
      return false
    }
  })()
  if (!supported && pref !== "webgl") return ref

  let disposed = false
  type RendererAddon = ITerminalAddon & {
    clearTextureAtlas?: () => void
    onContextLoss?: (fn: () => void) => void
  }
  let addon: RendererAddon | null = null

  ref.dispose = () => {
    disposed = true
    try {
      addon?.dispose()
    } catch {}
    addon = null
    ref.kind = "dom"
    ref.clearTextureAtlas = undefined
  }

  import("@xterm/addon-webgl")
    .then(({ WebglAddon }) => {
      if (disposed) return
      try {
        addon = new WebglAddon()
        xterm.loadAddon(addon)
        ref.kind = "webgl"
        ref.clearTextureAtlas = addon.clearTextureAtlas?.bind(addon)
        addon.onContextLoss?.(() => {
          // Context loss is recoverable by falling back to the default renderer.
          ref.dispose()
        })
      } catch {
        ref.dispose()
      }
    })
    .catch(() => {})

  return ref
}

// ============================================================================
// Terminal Instance Creation
// ============================================================================

export function createTerminalInstance(
  container: HTMLDivElement,
  options: {
    initialTheme?: ITheme | null
    fontFamily?: string
    onFileLinkClick?: (path: string, line?: number, col?: number) => void
    onUrlClick?: (event: MouseEvent, url: string) => void
  } = {},
): CreateTerminalResult {
  const theme = options.initialTheme ?? undefined
  const terminalOptions = { ...TERMINAL_OPTIONS, theme }
  if (options.fontFamily) {
    terminalOptions.fontFamily = options.fontFamily
  }

  const xterm = new XTerm(terminalOptions)
  const fitAddon = new FitAddon()
  const clipboardAddon = new ClipboardAddon()
  const unicode11Addon = new Unicode11Addon()
  let isDisposed = false
  let rafId: number | null = null

  const rendererRef: TerminalRendererRef = {
    current: { kind: "dom", dispose: () => {}, clearTextureAtlas: undefined },
  }

  flog("open", {
    clientWidth: container.clientWidth,
    clientHeight: container.clientHeight,
  })
  xterm.open(container)

  // Load non-renderer addons immediately
  xterm.loadAddon(fitAddon)
  xterm.loadAddon(clipboardAddon)
  xterm.loadAddon(unicode11Addon)
  // Register custom link providers (replaces WebLinksAddon)
  const urlProvider = new UrlLinkProvider(xterm, (event, uri) => {
    if (options.onUrlClick) {
      options.onUrlClick(event, uri)
    } else {
      window.open(uri, "_blank")
    }
  })
  xterm.registerLinkProvider(urlProvider)

  if (options.onFileLinkClick) {
    const fileProvider = new FilePathLinkProvider(xterm, (_event, path, line, col) => {
      options.onFileLinkClick!(path, line, col)
    })
    xterm.registerLinkProvider(fileProvider)
  }

  // Defer GPU renderer to next animation frame (avoids race condition).
  // After loading, fit immediately with the new cell metrics (GPU renderers
  // measure differently than DOM). Then dispatch an event so the coordinator
  // updates its lastCols/lastRows tracking and fires notify/clear if needed.
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (isDisposed) return
    rendererRef.current = loadRenderer(xterm)
    // Fit immediately after renderer loads — this is the fast path that sizes
    // the terminal correctly on the first frame. The coordinator event below
    // handles the bookkeeping (lastCols/lastRows, notify, clear).
    try {
      fitAddon.fit()
    } catch {}
    try {
      xterm.refresh(0, xterm.rows - 1)
    } catch {}
    flog("renderer-ready", {
      renderer: rendererRef.current.kind,
      cols: xterm.cols,
      rows: xterm.rows,
      proposed: (() => {
        try {
          return fitAddon.proposeDimensions()
        } catch {
          return undefined
        }
      })(),
    })
    window.dispatchEvent(new Event("opencode:terminal-fit"))
  })

  // Load ligatures addon async
  import("@xterm/addon-ligatures")
    .then(({ LigaturesAddon }) => {
      if (isDisposed) return
      try {
        xterm.loadAddon(new LigaturesAddon())
      } catch {}
    })
    .catch(() => {})

  xterm.unicode.activeVersion = "11"
  try {
    fitAddon.fit()
  } catch {
    // Container may be 0x0 on portal mount — coordinator + retry loop handle sizing later
  }
  flog("initial-fit", {
    cols: xterm.cols,
    rows: xterm.rows,
    proposed: (() => {
      try {
        return fitAddon.proposeDimensions()
      } catch {
        return undefined
      }
    })(),
  })

  // Re-trigger fit after fonts are ready. If the initial fit ran before fonts
  // loaded, xterm's cell dimensions may be 0 (proposeDimensions() returns
  // undefined) or measured against a fallback font. Either way the terminal
  // stays at the default 80×24. Dispatching the fit event after fonts.ready
  // lets the resize coordinator re-fit with accurate cell metrics.
  if (typeof document !== "undefined" && document.fonts) {
    document.fonts.ready.then(() => {
      if (isDisposed) return
      flog("fonts-ready", {
        cols: xterm.cols,
        rows: xterm.rows,
        proposed: (() => {
          try {
            return fitAddon.proposeDimensions()
          } catch {
            return undefined
          }
        })(),
      })
      window.dispatchEvent(new Event("opencode:terminal-fit"))
    })
  }

  return {
    xterm,
    fitAddon,
    renderer: rendererRef,
    cleanup: () => {
      isDisposed = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      rendererRef.current.dispose()
    },
  }
}

// ============================================================================
// Keyboard Handler
// ============================================================================

export function setupKeyboardHandler(
  xterm: XTerm,
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

// ============================================================================
// Paste Handler with Bracketed Paste
// ============================================================================

export function setupPasteHandler(
  xterm: XTerm,
  options: {
    onWrite?: (data: string) => void
    isBracketedPasteEnabled?: () => boolean
  } = {},
): () => void {
  const textarea = xterm.textarea
  if (!textarea) return () => {}

  // Track active paste to allow cancellation
  let cancelActivePaste: (() => void) | null = null

  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain")
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()

    // Cancel any in-flight chunked paste
    cancelActivePaste?.()
    cancelActivePaste = null

    // Constants for chunking
    const MAX_SYNC_PASTE_CHARS = 16_384
    const CHUNK_CHARS = 4096
    const CHUNK_DELAY_MS = 5

    if (!options.onWrite) {
      // Fallback to xterm's built-in paste (handles bracketed paste internally)
      if (text.length <= MAX_SYNC_PASTE_CHARS) {
        xterm.paste(text)
        return
      }

      // Chunk large pastes through xterm.paste()
      let cancelled = false
      let offset = 0

      const pasteNext = () => {
        if (cancelled) return
        const chunk = text.slice(offset, offset + CHUNK_CHARS)
        offset += CHUNK_CHARS
        xterm.paste(chunk)
        if (offset < text.length) {
          setTimeout(pasteNext, CHUNK_DELAY_MS)
        }
      }

      cancelActivePaste = () => {
        cancelled = true
      }
      pasteNext()
      return
    }

    // Normalize newlines for direct write
    const prepared = text.replace(/\r?\n/g, "\r")
    const bracketed = options.isBracketedPasteEnabled?.() ?? false

    // For small/medium pastes, use fast path
    if (prepared.length <= MAX_SYNC_PASTE_CHARS) {
      if (bracketed) {
        options.onWrite(`\x1b[200~${prepared}\x1b[201~`)
      } else {
        options.onWrite(prepared)
      }
      return
    }

    // Chunk large pastes to prevent PTY pipeline overflow
    let cancelled = false
    let offset = 0

    const pasteNext = () => {
      if (cancelled) return
      const chunk = prepared.slice(offset, offset + CHUNK_CHARS)
      offset += CHUNK_CHARS

      if (bracketed) {
        // Wrap each chunk to avoid long-running open bracketed paste blocks
        options.onWrite?.(`\x1b[200~${chunk}\x1b[201~`)
      } else {
        options.onWrite?.(chunk)
      }

      if (offset < prepared.length) {
        setTimeout(pasteNext, CHUNK_DELAY_MS)
      }
    }

    cancelActivePaste = () => {
      cancelled = true
    }
    pasteNext()
  }

  textarea.addEventListener("paste", handlePaste, { capture: true })
  return () => {
    cancelActivePaste?.()
    cancelActivePaste = null
    textarea.removeEventListener("paste", handlePaste, { capture: true })
  }
}

// ============================================================================
// Copy Handler (Trim Whitespace)
// ============================================================================

export function setupCopyHandler(xterm: XTerm): () => void {
  const element = xterm.element
  if (!element) return () => {}

  const handleCopy = (event: ClipboardEvent) => {
    const selection = xterm.getSelection()
    if (!selection) return

    // Trim trailing whitespace from each line
    const trimmed = selection
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
    event.preventDefault()
    event.clipboardData?.setData("text/plain", trimmed)
  }

  element.addEventListener("copy", handleCopy)
  return () => element.removeEventListener("copy", handleCopy)
}

// ============================================================================
// Drop Handler (File Path Paste)
// ============================================================================

/**
 * Parse file:// URIs from a text/uri-list string into filesystem paths.
 */
function parseFileUris(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("file://"))
    .map((uri) => {
      // Remove the file:// prefix. On Windows, file URIs look like
      // file:///C:/path — we strip the leading slash for drive letters.
      let path = decodeURIComponent(uri.replace(/^file:\/\//, ""))
      // Windows drive-letter check: /C:/ → C:/
      if (/^\/[A-Za-z]:\//.test(path)) {
        path = path.slice(1)
      }
      return path
    })
}

export function setupDropHandler(
  xterm: XTerm,
  container: HTMLDivElement,
  options: {
    onWrite: (data: string) => void
    isBracketedPasteEnabled?: () => boolean
  },
): () => void {
  const handleDragOver = (event: DragEvent) => {
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy"
    }
  }

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()

    const dt = event.dataTransfer
    if (!dt) return

    // Determine synchronously whether we can extract paths, so we can
    // call stopPropagation before the microtask boundary.  If neither
    // strategy applies, let the event bubble to the document-level
    // handler (prompt-input attachments) instead of swallowing it.
    const isTauri = !!(window as any).__TAURI__ && !!dt.files?.length
    const isElectron = !!(window as any).api && !!dt.files?.length
    const uriList = dt.getData("text/uri-list")
    const hasUris = !!uriList && parseFileUris(uriList).length > 0

    if (!isTauri && !isElectron && !hasUris) return

    // We can handle this drop — prevent the global handler from also acting.
    event.stopPropagation()

    const paths: string[] = []

    // Strategy 1: Tauri desktop — send file blobs to Rust for temp save
    if (isTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        for (const file of Array.from(dt.files)) {
          const data = new Uint8Array(await file.arrayBuffer())
          const savedPath = await invoke<string>("save_dropped_file", {
            name: file.name,
            data: Array.from(data),
          })
          paths.push(savedPath)
        }
      } catch {
        // Fall through to URI fallback
      }
    }

    // Strategy 2: Electron — use preload's webUtils.getPathForFile()
    if (isElectron && paths.length === 0) {
      const api = (window as any).api
      if (typeof api?.getDroppedFilePaths === "function") {
        const resolved = api.getDroppedFilePaths(Array.from(dt.files)) as string[]
        paths.push(...resolved)
      }
    }

    // Strategy 3: text/uri-list fallback (Finder/Explorer provide file:// URIs)
    if (paths.length === 0 && uriList) {
      paths.push(...parseFileUris(uriList))
    }

    if (paths.length === 0) return

    // Shell-escape and write
    const { quote } = await import("shell-quote")
    const escaped = paths.map((p) => quote([p])).join(" ")
    const bracketed = options.isBracketedPasteEnabled?.() ?? false

    if (bracketed) {
      options.onWrite(`\x1b[200~${escaped}\x1b[201~`)
    } else {
      options.onWrite(escaped)
    }
  }

  container.addEventListener("dragover", handleDragOver)
  container.addEventListener("drop", handleDrop)
  return () => {
    container.removeEventListener("dragover", handleDragOver)
    container.removeEventListener("drop", handleDrop)
  }
}

// ============================================================================
// Resize Handler
// ============================================================================

export interface ResizeHandlersResult {
  coordinator: ResizeCoordinator
  cleanup: () => void
}

export function setupResizeHandlers(
  container: HTMLDivElement,
  xterm: XTerm,
  fitAddon: FitAddon,
  onResize: (cols: number, rows: number) => void,
  renderer?: TerminalRendererRef,
): ResizeHandlersResult {
  const snapshot = () => ({
    clientWidth: Math.round(container.clientWidth),
    clientHeight: Math.round(container.clientHeight),
    cols: xterm.cols,
    rows: xterm.rows,
    proposed: (() => {
      try {
        return fitAddon.proposeDimensions()
      } catch {
        return undefined
      }
    })(),
  })
  // Guard: xterm's internal RenderService accesses `_renderer.value.dimensions`
  // during resize()/refresh(). When a WebGL addon is loading asynchronously,
  // the internal _renderer ref can be undefined, causing a TypeError. Check
  // xterm's internal _renderService._renderer.value as a proxy for readiness.
  const isRendererReady = () => {
    try {
      const core = (xterm as any)._core
      return !!core?._renderService?._renderer?.value
    } catch {
      return false
    }
  }

  const coordinator = createResizeCoordinator({
    fit: () => {
      if (!isRendererReady()) return
      // proposeDimensions() can throw or return undefined right after reload /
      // portal mount (renderer/font metrics not ready). Still attempt a fit so
      // xterm paints; failures are tolerated and refresh() will still run.
      try {
        const dims = (() => {
          try {
            return fitAddon.proposeDimensions()
          } catch {
            return undefined
          }
        })()
        if (!dims) {
          try {
            fitAddon.fit()
          } catch {}
          return
        }
        fitAddon.fit()
      } catch {}
    },
    measure: () => ({ width: container.clientWidth, height: container.clientHeight }),
    getCols: () => xterm.cols,
    getRows: () => xterm.rows,
    refresh: () => {
      if (!isRendererReady()) return
      try { xterm.refresh(0, xterm.rows - 1) } catch {}
      try { renderer?.current.clearTextureAtlas?.() } catch {}
    },
    clear: () => {
      // Fix Ink-style TUI duplication after resize/rewrap by clearing the
      // visible screen before the app re-renders on SIGWINCH.
      //
      // Only do this in the alternate buffer. Clearing the normal buffer would
      // destroy scrollback / shell history.
      try {
        if ((xterm.buffer.active as unknown as { type?: string })?.type !== "alternate") return
      } catch {
        return
      }
      try {
        // Clear uses current SGR attributes. If a TUI leaves the "composer"
        // background active, ESC[2J will paint the cleared region with that
        // background, leaving a wide blank bar after resize. Reset attributes
        // first so cleared cells use the terminal default theme.
        xterm.write("\x1b[0m\x1b[H\x1b[2J")
        flog("coordinator-clear", {
          cols: xterm.cols,
          rows: xterm.rows,
          viewportY: xterm.buffer.active.viewportY,
          baseY: xterm.buffer.active.baseY,
        })
      } catch {}
    },
    notify: (cols, rows) => {
      flog("coordinator-notify", {
        cols,
        rows,
        snapshot: snapshot(),
      })
      onResize(cols, rows)
    },
    clock: {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id: number) => clearTimeout(id),
    },
    raf: {
      request: (fn: () => void) => requestAnimationFrame(fn),
      cancel: (id: number) => cancelAnimationFrame(id),
    },
  })

  // Check global suspension flag
  const isSuspended = () =>
    typeof document !== "undefined" && document.documentElement.dataset.terminalResizeSuspended === "1"

  let wasSuspended = isSuspended()

  const checkSuspension = () => {
    const nowSuspended = isSuspended()
    if (nowSuspended && !wasSuspended) {
      coordinator.suspend()
    } else if (!nowSuspended && wasSuspended) {
      coordinator.resume()
    }
    wasSuspended = nowSuspended
  }

  const handleResize = () => {
    flog("window-resize", snapshot())
    checkSuspension()
    coordinator.request("window-resize")
  }

  // Track container size transitions. Nudge fontSize to force xterm to
  // re-measure cell metrics when:
  //   1. Container goes from 0x0 to non-zero (tab switch from display:none)
  //   2. Container width changes significantly (>20%) — e.g., pane split
  // Without the nudge, xterm's WebGL renderer caches stale cell dimensions
  // and text appears garbled after a split.
  let lastObservedWidth = 0
  let lastObservedHeight = 0

  const resizeObserver = new ResizeObserver((entries) => {
    if (!container.isConnected) return

    const entry = entries[0]
    const width = entry?.contentRect?.width ?? container.clientWidth
    const height = entry?.contentRect?.height ?? container.clientHeight

    const wasZero = lastObservedWidth === 0 && lastObservedHeight === 0
    const significantWidthChange =
      lastObservedWidth > 0 &&
      width > 0 &&
      Math.abs(width - lastObservedWidth) / lastObservedWidth > 0.2

    if ((wasZero && width > 0 && height > 0) || significantWidthChange) {
      // Force cell re-measurement so fitAddon.fit() uses correct metrics
      const fs = xterm.options.fontSize ?? 14
      xterm.options.fontSize = fs + 0.001
      xterm.options.fontSize = fs
    }

    lastObservedWidth = width
    lastObservedHeight = height

    checkSuspension()
    flog("resize-observer", { width, height, snapshot: snapshot() })
    coordinator.request("resize-observer")
  })
  resizeObserver.observe(container)
  window.addEventListener("resize", handleResize)

  const handleFit = () => {
    flog("fit-event", snapshot())
    checkSuspension()
    coordinator.request("fit-event")
  }
  window.addEventListener("opencode:terminal-fit", handleFit)

  // Visibility change: request fit when tab becomes visible
  const handleVisibilityChange = () => {
    if (document.hidden) return
    flog("visibility", snapshot())
    coordinator.request("visibility")
  }
  document.addEventListener("visibilitychange", handleVisibilityChange)

  // Initial mount fits (tab/portal mount can report 0px initially)
  requestAnimationFrame(() => coordinator.request("mount"))
  const mountTimer = setTimeout(() => coordinator.request("mount"), 50)
  const mountLateTimer = setTimeout(() => coordinator.request("mount"), 250)
  flog("mount-scheduled", snapshot())

  // Safety net: poll for dimension mismatch for the first 3 seconds.
  // Handles the case where fitAddon.fit() was a no-op because cell dims were 0
  // (container was display:none or renderer hadn't measured font yet).
  let retryCount = 0
  const retryTimer = setInterval(() => {
    retryCount++
    if (retryCount >= 10) {
      clearInterval(retryTimer)
      return
    }
    if (container.clientWidth < MIN_CONTAINER_PX) return
    const proposed = fitAddon.proposeDimensions()
    if (!proposed) return
    flog("retry-fit", {
      retryCount,
      proposed,
      snapshot: snapshot(),
    })
    if (proposed.cols !== xterm.cols || proposed.rows !== xterm.rows) {
      coordinator.request("retry-fit")
    } else {
      // Dims match — terminal is correctly sized, stop polling
      flog("retry-fit-stable", { retryCount, snapshot: snapshot() })
      clearInterval(retryTimer)
    }
  }, 200)

  return {
    coordinator,
    cleanup: () => {
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("opencode:terminal-fit", handleFit)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      resizeObserver.disconnect()
      clearTimeout(mountTimer)
      clearTimeout(mountLateTimer)
      clearInterval(retryTimer)
      coordinator.dispose()
    },
  }
}
