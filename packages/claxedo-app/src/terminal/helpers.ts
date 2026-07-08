import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { ClipboardAddon } from "@xterm/addon-clipboard"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { TERMINAL_OPTIONS, MIN_CONTAINER_PX } from "./config"
import { UrlLinkProvider, FilePathLinkProvider } from "./link-providers"
import { createResizeCoordinator, type ResizeCoordinator } from "./resize-coordinator"
import type { ITheme, ITerminalAddon } from "@xterm/xterm"

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

type KeyboardHandlerTerminal = Pick<XTerm, "attachCustomKeyEventHandler">
type PasteHandlerTerminal = Pick<XTerm, "textarea" | "paste">
type CopyHandlerTerminal = Pick<XTerm, "element" | "getSelection">

function objectProperty(value: unknown, property: PropertyKey) {
  if (!value || typeof value !== "object") return undefined
  return Reflect.get(value, property)
}

function terminalApi() {
  if (typeof window === "undefined") return undefined
  return objectProperty(window, "api")
}

// ============================================================================
// Renderer Loading
// ============================================================================

// Cache the WebGL support probe so we only create (and lose) one throwaway
// context for the entire page lifetime instead of one per terminal mount.
let _webglSupported: boolean | undefined

function terminalLigaturesEnabled(): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    return localStorage.getItem("opencode.terminal.ligatures") === "1"
  } catch {
    return false
  }
}

function shouldPreferDomRenderer(): boolean {
  if (typeof window === "undefined") return false
  if (window.matchMedia?.("(pointer: coarse)")?.matches) return true
  return window.innerWidth <= 767
}

function isWebGLSupported(): boolean {
  if (_webglSupported !== undefined) return _webglSupported
  _webglSupported = false
  if (typeof document === "undefined") return false
  const el = document.createElement("canvas")
  if (typeof el.getContext !== "function") return false
  try {
    const gl = el.getContext("webgl2") || el.getContext("webgl")
    if (gl) {
      _webglSupported = true
      // Immediately lose the probe context so it doesn't count against the
      // browser's active WebGL context limit (~16).
      const ext = (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")
      ext?.loseContext()
    }
  } catch {
    // not supported
  }
  return _webglSupported
}

// Track active WebGL renderer count globally. Chromium allows ~16 contexts per
// page, but rapid terminal remounts (e.g. SolidJS <Show keyed> store updates)
// can create new contexts before the async addon import on the old terminal has
// been cancelled, leading to transient overlap. Cap to a safe ceiling so we
// never hit the browser limit and trigger "oldest context will be lost" warnings.
const MAX_WEBGL_RENDERERS = 12
let _activeWebGLCount = 0

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

  // Mobile Safari/Chrome and DevTools device emulation can briefly paint WebGL
  // output, then lose or blank the xterm canvas while the PTY keeps streaming.
  // Keep mobile on the DOM renderer unless WebGL is explicitly forced.
  if (pref !== "webgl" && shouldPreferDomRenderer()) return ref

  if (!isWebGLSupported() && pref !== "webgl") return ref

  // Skip WebGL if we've already hit the safe ceiling
  if (_activeWebGLCount >= MAX_WEBGL_RENDERERS) return ref

  let disposed = false
  let counted = false
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
    if (counted) {
      _activeWebGLCount = Math.max(0, _activeWebGLCount - 1)
      counted = false
    }
    ref.kind = "dom"
    ref.clearTextureAtlas = undefined
  }

  import("@xterm/addon-webgl")
    .then(({ WebglAddon }) => {
      if (disposed) return
      // Re-check ceiling after async import — other terminals may have loaded
      // their WebGL addons while this import was in flight.
      if (_activeWebGLCount >= MAX_WEBGL_RENDERERS) return
      try {
        addon = new WebglAddon()
        xterm.loadAddon(addon)
        ref.kind = "webgl"
        _activeWebGLCount++
        counted = true
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
    window.dispatchEvent(new Event("opencode:terminal-fit"))
  })

  // The ligatures addon deregisters character joiners during dispose, which
  // asks xterm to refresh rows. During HMR/mobile remounts that refresh can run
  // after the renderer is already gone, causing RenderService dimensions errors.
  if (terminalLigaturesEnabled()) {
    import("@xterm/addon-ligatures")
      .then(({ LigaturesAddon }) => {
        if (isDisposed) return
        try {
          xterm.loadAddon(new LigaturesAddon())
        } catch {}
      })
      .catch(() => {})
  }

  xterm.unicode.activeVersion = "11"
  try {
    fitAddon.fit()
  } catch {
    // Container may be 0x0 on portal mount — coordinator + retry loop handle sizing later
  }
  // Re-trigger fit after fonts are ready. If the initial fit ran before fonts
  // loaded, xterm's cell dimensions may be 0 (proposeDimensions() returns
  // undefined) or measured against a fallback font. Either way the terminal
  // stays at the default 80×24. Dispatching the fit event after fonts.ready
  // lets the resize coordinator re-fit with accurate cell metrics.
  if (typeof document !== "undefined" && document.fonts) {
    void document.fonts.ready
      .then(() => {
        if (isDisposed) return
        window.dispatchEvent(new Event("opencode:terminal-fit"))
      })
      .catch(() => {})
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

// ============================================================================
// Paste Handler with Bracketed Paste
// ============================================================================

export function setupPasteHandler(
  xterm: PasteHandlerTerminal,
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
    if (!text) {
      // Non-text clipboard content (e.g. image): forward Ctrl+V so the
      // application can decide what to do with it (iTerm2/Ghostty behaviour).
      if (options.onWrite) options.onWrite("\x16")
      return
    }

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

export function setupCopyHandler(xterm: CopyHandlerTerminal): () => void {
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
    if (event.clipboardData) {
      event.preventDefault()
      event.clipboardData.setData("text/plain", trimmed)
    } else {
      // Wayland / some Linux environments: clipboardData is null on synthetic events
      void navigator.clipboard?.writeText(trimmed).catch(() => {})
    }
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

function imageFile(file: File) {
  return file.type.startsWith("image/")
}

async function writeImage(file: File) {
  const writeClipboardImage = objectProperty(terminalApi(), "writeClipboardImage")
  if (typeof writeClipboardImage !== "function") return false
  const buf = await file.arrayBuffer().catch(() => undefined)
  if (!buf) return false
  return writeClipboardImage(buf)
}

export function setupDropHandler(
  _xterm: unknown,
  container: HTMLDivElement,
  options: {
    image?: "path" | "paste"
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
    const files = Array.from(dt.files ?? [])

    // Determine synchronously whether we can extract paths, so we can
    // call stopPropagation before the microtask boundary.  If neither
    // strategy applies, let the event bubble to the document-level
    // handler (prompt-input attachments) instead of swallowing it.
    const api = terminalApi()
    const isElectron = !!api && files.length > 0
    const uriList = dt.getData("text/uri-list")
    const hasUris = !!uriList && parseFileUris(uriList).length > 0
    const canPaste = isElectron && (options.image ?? "path") === "paste" && files.length > 0 && files.every(imageFile)

    if (!isElectron && !hasUris && !canPaste) return

    // We can handle this drop, so keep the document-level prompt handler from
    // processing it a second time.
    event.stopPropagation()

    if (canPaste) {
      let ok = false
      for (const file of files) {
        const wrote = await writeImage(file)
        if (!wrote) continue
        ok = true
        options.onWrite("\x16")
      }
      if (ok) return
    }

    const paths: string[] = []

    // Strategy 1: Electron — use preload's webUtils.getPathForFile()
    if (isElectron && paths.length === 0) {
      const getDroppedFilePaths = objectProperty(api, "getDroppedFilePaths")
      if (typeof getDroppedFilePaths === "function") {
        const resolved = getDroppedFilePaths(files)
        if (Array.isArray(resolved)) {
          paths.push(...resolved.filter((item) => typeof item === "string"))
        }
      }
    }

    // Strategy 2: text/uri-list fallback (Finder/Explorer provide file:// URIs)
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
  // Guard: xterm's internal RenderService accesses `_renderer.value.dimensions`
  // during resize()/refresh(). When a WebGL addon is loading asynchronously,
  // the internal _renderer ref can be undefined, causing a TypeError. Check
  // xterm's internal _renderService._renderer.value as a proxy for readiness.
  const isRendererReady = () => {
    try {
      const renderer = objectProperty(
        objectProperty(objectProperty(xterm, "_core"), "_renderService"),
        "_renderer",
      )
      return !!objectProperty(renderer, "value")
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
        const active = xterm.buffer.active
        if (!("type" in active) || active.type !== "alternate") return
      } catch {
        return
      }
      try {
        // Clear uses current SGR attributes. If a TUI leaves the "composer"
        // background active, ESC[2J will paint the cleared region with that
        // background, leaving a wide blank bar after resize. Reset attributes
        // first so cleared cells use the terminal default theme.
        xterm.write("\x1b[0m\x1b[H\x1b[2J")
      } catch {}
    },
    notify: (cols, rows) => {
      onResize(cols, rows)
    },
    clock: {
      setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
      clearTimeout: (id: number) => window.clearTimeout(id),
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

      // Immediately fit + clear atlas + refresh so the canvas dimensions
      // update in the same frame as the font-nudge. Without this, the
      // coordinator's deferred settle runs 1+ frames later, during which
      // the WebGL renderer paints with stale canvas resolution → pixelated.
      if (isRendererReady()) {
        try { fitAddon.fit() } catch {}
        try { renderer?.current.clearTextureAtlas?.() } catch {}
        try { xterm.refresh(0, xterm.rows - 1) } catch {}
      }
    }

    lastObservedWidth = width
    lastObservedHeight = height

    checkSuspension()
    coordinator.request("resize-observer")
  })
  resizeObserver.observe(container)
  window.addEventListener("resize", handleResize)

  const handleFit = () => {
    checkSuspension()
    coordinator.request("fit-event")
  }
  window.addEventListener("opencode:terminal-fit", handleFit)

  // Visibility change: request fit when tab becomes visible
  const handleVisibilityChange = () => {
    if (document.hidden) return
    coordinator.request("visibility")
  }
  document.addEventListener("visibilitychange", handleVisibilityChange)

  // Window focus: recover rendering after OS window switch (clears WebGL texture atlas
  // which can become stale after the window was occluded by another app).
  const handleWindowFocus = () => {
    coordinator.request("visibility")
  }
  window.addEventListener("focus", handleWindowFocus)

  // Initial mount fits (tab/portal mount can report 0px initially)
  requestAnimationFrame(() => coordinator.request("mount"))
  const mountTimer = setTimeout(() => coordinator.request("mount"), 50)
  const mountLateTimer = setTimeout(() => coordinator.request("mount"), 250)

  // Safety net for early 0px/font-metric mount races: retry briefly, then stop.
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const retryFit = () => {
    retryCount++
    if (retryCount >= 10) return
    const proposed = container.clientWidth >= MIN_CONTAINER_PX ? fitAddon.proposeDimensions() : undefined
    const mismatch = proposed && (proposed.cols !== xterm.cols || proposed.rows !== xterm.rows)
    if (mismatch) coordinator.request("retry-fit")
    if (!proposed || mismatch) retryTimer = setTimeout(retryFit, 200)
  }
  retryTimer = setTimeout(retryFit, 200)

  return {
    coordinator,
    cleanup: () => {
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("opencode:terminal-fit", handleFit)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("focus", handleWindowFocus)
      resizeObserver.disconnect()
      clearTimeout(mountTimer)
      clearTimeout(mountLateTimer)
      clearTimeout(retryTimer)
      coordinator.dispose()
    },
  }
}
