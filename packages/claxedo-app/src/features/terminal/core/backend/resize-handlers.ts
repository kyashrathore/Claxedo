import type { Terminal as XTerm } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import { MIN_CONTAINER_PX } from "../config"
import { createResizeCoordinator, type ResizeCoordinator } from "../resize-coordinator"
import { onTerminalFitEvent } from "../fit-event"
import { objectProperty } from "./reflect"
import type { TerminalRendererRef } from "./renderer"
import { cancelParserIdleWork, createParserIdleGate, runWhenParserIdle, type ParserIdleGate } from "../parser-idle-gate"

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
  /** Gate that defers a fit while the xterm parser is mid-async-handler.
   *  Optional so existing tests can construct handlers without one. */
  parserGate: ParserIdleGate = createParserIdleGate(),
  /** Remote PTYs apply geometry through ordered host checkpoints. */
  requestHostSize?: (cols: number, rows: number) => void,
): ResizeHandlersResult {
  // Guard: xterm's internal RenderService accesses `_renderer.value.dimensions`
  // during resize()/refresh(). When a WebGL addon is loading asynchronously,
  // the internal _renderer ref can be undefined, causing a TypeError. Check
  // xterm's internal _renderService._renderer.value as a proxy for readiness.
  const isRendererReady = () => {
    try {
      const rendererRef = objectProperty(
        objectProperty(objectProperty(xterm, "_core"), "_renderService"),
        "_renderer",
      )
      return !!objectProperty(rendererRef, "value")
    } catch {
      return false
    }
  }

  const isSuspended = () =>
    typeof document !== "undefined" && document.documentElement.dataset.terminalResizeSuspended === "1"
  let disposed = false
  let fontMetricsDirty = false
  let proposedSize: { cols: number; rows: number } | undefined

  const refresh = () => {
    if (disposed || !isRendererReady()) return
    try { xterm.refresh(0, xterm.rows - 1) } catch {}
    try { renderer?.current.clearTextureAtlas?.() } catch {}
  }

  // Every fit, including the immediate observer path, enters through the parser
  // gate. Keep metric invalidation pending across drag suspension and parsing.
  const runFit = () => {
    if (disposed || isSuspended() || !isRendererReady()) return
    const remeasure = fontMetricsDirty
    if (remeasure) {
      fontMetricsDirty = false
      const fs = xterm.options.fontSize ?? 14
      xterm.options.fontSize = fs + 0.001
      xterm.options.fontSize = fs
    }
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
        if (requestHostSize) return
        try {
          fitAddon.fit()
        } catch {}
        return
      }
      if (requestHostSize) {
        proposedSize = dims
        requestHostSize(dims.cols, dims.rows)
        return
      }
      fitAddon.fit()
    } catch {} finally {
      // A metric nudge must repaint in the same parser-idle turn as its fit.
      if (remeasure) refresh()
    }
  }

  const coordinator = createResizeCoordinator({
    fit: () => {
      if (!isRendererReady()) return
      // fit() -> resize() -> WriteBuffer.flushSync() re-enters the parser, which
      // is illegal while an async parser handler is paused mid-write and leaves
      // the parser permanently FAILed. Park the fit until the parser is idle;
      // it runs synchronously in the common case (nothing in flight).
      runWhenParserIdle(parserGate, runFit)
    },
    measure: () => ({ width: container.clientWidth, height: container.clientHeight }),
    getCols: () => proposedSize?.cols ?? xterm.cols,
    getRows: () => proposedSize?.rows ?? xterm.rows,
    refresh,
    notify: (cols, rows) => onResize(cols, rows),
    clock: {
      setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
      clearTimeout: (id: number) => window.clearTimeout(id),
    },
    raf: {
      request: (fn: () => void) => requestAnimationFrame(fn),
      cancel: (id: number) => cancelAnimationFrame(id),
    },
  })

  let wasSuspended = isSuspended()
  if (wasSuspended) coordinator.suspend()

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
    if (disposed || !container.isConnected) return
    checkSuspension()

    const entry = entries[0]
    const width = entry?.contentRect?.width ?? container.clientWidth
    const height = entry?.contentRect?.height ?? container.clientHeight

    const wasZero = lastObservedWidth === 0 && lastObservedHeight === 0
    const significantWidthChange =
      lastObservedWidth > 0 &&
      width > 0 &&
      Math.abs(width - lastObservedWidth) / lastObservedWidth > 0.2

    if ((wasZero && width > 0 && height > 0) || significantWidthChange) {
      fontMetricsDirty = true
      if (!wasSuspended && isRendererReady()) {
        runWhenParserIdle(parserGate, runFit)
      }
    }

    lastObservedWidth = width
    lastObservedHeight = height

    checkSuspension()
    coordinator.request("resize-observer")
  })
  resizeObserver.observe(container)
  window.addEventListener("resize", handleResize)

  const removeFitListener = onTerminalFitEvent(window, () => {
    checkSuspension()
    coordinator.request("fit-event")
  })

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
      disposed = true
      cancelParserIdleWork(parserGate)
      window.removeEventListener("resize", handleResize)
      removeFitListener()
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
