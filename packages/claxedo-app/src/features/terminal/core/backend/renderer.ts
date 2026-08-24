import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { ClipboardAddon } from "@xterm/addon-clipboard"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { TERMINAL_OPTIONS, getScreenReaderModePreference } from "../config"
import { UrlLinkProvider, FilePathLinkProvider } from "../link-providers/index"
import { dispatchTerminalFitEvent } from "../fit-event"
import { BP_MD } from "@/ui/controls/breakpoints"
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

/**
 * Probe (once, un-memoized) whether the environment can create a WebGL context.
 * Immediately loses the probe context so it doesn't count against the browser's
 * active WebGL context limit (~16). Exported un-memoized so tests can inject a
 * fake document; production goes through the memoized `isWebGLSupported`.
 */
export function probeWebGL(
  doc: Pick<Document, "createElement"> | undefined = typeof document !== "undefined" ? document : undefined,
): boolean {
  if (!doc) return false
  const el = doc.createElement("canvas") as HTMLCanvasElement
  if (typeof el.getContext !== "function") return false
  try {
    const gl = el.getContext("webgl2") || el.getContext("webgl")
    if (gl) {
      const ext = (gl as WebGLRenderingContext).getExtension?.("WEBGL_lose_context")
      ext?.loseContext?.()
      return true
    }
  } catch {
    // not supported
  }
  return false
}

function isWebGLSupported(): boolean {
  if (_webglSupported === undefined) _webglSupported = probeWebGL()
  return _webglSupported
}

/**
 * Mobile Safari/Chrome and DevTools device emulation can briefly paint WebGL
 * output, then lose or blank the xterm canvas while the PTY keeps streaming.
 * Keep these environments on the DOM renderer. Exported with an injectable
 * window so the coarse-pointer / narrow-viewport fallback is directly testable.
 */
export function shouldPreferDomRenderer(
  win: Pick<Window, "matchMedia" | "innerWidth"> | undefined = typeof window !== "undefined" ? window : undefined,
): boolean {
  if (!win) return false
  if (win.matchMedia?.("(pointer: coarse)")?.matches) return true
  // Below the md boundary (BP_MD). Kept as `<= BP_MD - 1` (not `< BP_MD`) to
  // preserve the exact original `<= 767` semantics for fractional widths — this
  // is a safety-critical WebGL-blanking fallback, not layout polish.
  return win.innerWidth <= BP_MD - 1
}

// Track active WebGL renderer count globally. Chromium allows ~16 contexts per
// page, but rapid terminal remounts (e.g. SolidJS <Show keyed> store updates)
// can create new contexts before the async addon import on the old terminal has
// been cancelled, leading to transient overlap. Cap to a safe ceiling so we
// never hit the browser limit and trigger "oldest context will be lost" warnings.
export const MAX_WEBGL_RENDERERS = 12
let _activeWebGLCount = 0

/**
 * Pure decision: given the renderer preference, DOM-fallback signal, WebGL
 * support probe, and the current active-context count, should this mount attempt
 * to load the WebGL renderer? Extracted so the ceiling/probe/coarse-pointer
 * rules are testable without a real xterm or GPU.
 *
 * `webglSupported` is a THUNK, not a boolean, and is invoked lazily — only after
 * the pref / DOM-preference short-circuits have passed. This preserves the
 * pre-extraction short-circuit order: a DOM-forced (`pref === "dom"`) or
 * mobile/coarse-pointer mount returns `false` WITHOUT ever probing WebGL, so it
 * never creates (and immediately loses) a throwaway WebGL context. Passing the
 * probe as an eagerly-evaluated boolean argument would regress that, firing the
 * probe on every mount including the DOM paths that short-circuit here.
 *
 * - pref "dom": never attempt WebGL (and never probe).
 * - pref "webgl": force WebGL past the DOM-fallback and support checks (never
 *   probes — the support result is forced — but still respects the ceiling).
 * - otherwise: probe only when not on a DOM-preferring device, then attempt when
 *   WebGL is supported and we're under the active-context ceiling.
 */
export function shouldAttemptWebGL(input: {
  pref: string
  preferDom: boolean
  webglSupported: () => boolean
  activeCount: number
  max: number
}): boolean {
  if (input.pref === "dom") return false
  if (input.pref !== "webgl" && input.preferDom) return false
  if (input.pref !== "webgl" && !input.webglSupported()) return false
  if (input.activeCount >= input.max) return false
  return true
}

function rendererPreference(): string {
  if (typeof localStorage === "undefined") return ""
  try {
    return localStorage.getItem("opencode.terminal.renderer") ?? ""
  } catch {
    return ""
  }
}

export function loadRenderer(
  xterm: XTerm,
  deps: {
    // Injectable for tests so a counting fake can prove the DOM-forced /
    // coarse-pointer paths short-circuit BEFORE the WebGL support probe runs.
    preferDom?: () => boolean
    webglSupported?: () => boolean
  } = {},
): TerminalRendererRef["current"] {
  const ref: TerminalRendererRef["current"] = {
    kind: "dom",
    dispose: () => {},
    clearTextureAtlas: undefined,
  }

  // Allow an escape hatch for debugging / problematic GPUs:
  // - "dom": don't attempt WebGL
  // - "webgl": attempt WebGL (still falls back if unsupported)
  // - unset/other: attempt WebGL
  const pref = rendererPreference()

  if (
    !shouldAttemptWebGL({
      pref,
      preferDom: (deps.preferDom ?? shouldPreferDomRenderer)(),
      // Pass the probe as a thunk so shouldAttemptWebGL only invokes it once
      // WebGL is genuinely a candidate (see its short-circuit contract).
      webglSupported: deps.webglSupported ?? isWebGLSupported,
      activeCount: _activeWebGLCount,
      max: MAX_WEBGL_RENDERERS,
    })
  ) {
    return ref
  }

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
    onFileLinkClick?: (path: string, line?: number, col?: number, lineEnd?: number, colEnd?: number) => void
    onUrlClick?: (event: MouseEvent, url: string) => void
  } = {},
): CreateTerminalResult {
  const theme = options.initialTheme ?? undefined
  const terminalOptions = { ...TERMINAL_OPTIONS, theme }
  if (options.fontFamily) {
    terminalOptions.fontFamily = options.fontFamily
  }
  // Seed each new terminal from the persisted accessibility preference so a
  // screen-reader user gets the accessible DOM layer from first paint.
  // (TERMINAL_OPTIONS narrows screenReaderMode to the literal `false`; widen
  // for the write since this is now a runtime-driven boolean.)
  ;(terminalOptions as { screenReaderMode: boolean }).screenReaderMode = getScreenReaderModePreference()

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
    const fileProvider = new FilePathLinkProvider(xterm, (_event, path, line, col, lineEnd, colEnd) => {
      options.onFileLinkClick!(path, line, col, lineEnd, colEnd)
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
    dispatchTerminalFitEvent()
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
        dispatchTerminalFitEvent()
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
