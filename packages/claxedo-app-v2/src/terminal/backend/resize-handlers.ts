import type { Terminal as XTerm } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import { objectProperty } from "./reflect"
import { createResizeCoordinator, type ResizeCoordinator } from "./resize-coordinator"
import { cancelParserIdleWork, runWhenParserIdle, type ParserGate } from "./parser-gate"
import type { RendererHandle } from "./renderer-webgl"

export type ResizeHandlers = {
  readonly coordinator: ResizeCoordinator
  readonly cleanup: () => void
}

const SIGNIFICANT_WIDTH_CHANGE = 0.2

function rendererReady(xterm: XTerm): boolean {
  const renderer = objectProperty(objectProperty(objectProperty(xterm, "_core"), "_renderService"), "_renderer")
  return !!objectProperty(renderer, "value")
}

function resizeSuspended(): boolean {
  return document.documentElement.dataset.terminalResizeSuspended === "1"
}

export function setupResizeHandlers(input: {
  container: HTMLDivElement
  xterm: XTerm
  fitAddon: FitAddon
  renderer: RendererHandle
  parserGate: ParserGate
  onResize: (cols: number, rows: number) => void
}): ResizeHandlers {
  const { container, xterm, fitAddon, renderer, parserGate } = input
  let disposed = false
  let fontMetricsDirty = false

  const refresh = () => {
    if (disposed || !rendererReady(xterm)) return
    xterm.refresh(0, xterm.rows - 1)
    renderer.clearTextureAtlas()
  }

  const remeasureFont = () => {
    fontMetricsDirty = false
    const size = xterm.options.fontSize ?? 14
    xterm.options.fontSize = size + 0.001
    xterm.options.fontSize = size
  }

  const runFit = () => {
    if (disposed || resizeSuspended() || !rendererReady(xterm)) return
    const remeasure = fontMetricsDirty
    if (remeasure) remeasureFont()
    if (fitAddon.proposeDimensions()) fitAddon.fit()
    if (remeasure) refresh()
  }

  const coordinator = createResizeCoordinator({
    fit: () => runWhenParserIdle(parserGate, runFit),
    measure: () => ({ width: container.clientWidth, height: container.clientHeight }),
    size: () => ({ cols: xterm.cols, rows: xterm.rows }),
    refresh,
    notify: input.onResize,
  })

  let wasSuspended = resizeSuspended()
  if (wasSuspended) coordinator.suspend()
  const checkSuspension = () => {
    const suspended = resizeSuspended()
    if (suspended && !wasSuspended) coordinator.suspend()
    else if (!suspended && wasSuspended) coordinator.resume()
    wasSuspended = suspended
  }

  let lastWidth = 0
  let lastHeight = 0
  const observer = new ResizeObserver((entries) => {
    if (disposed || !container.isConnected) return
    checkSuspension()
    const rect = entries[0]?.contentRect
    const width = rect?.width ?? container.clientWidth
    const height = rect?.height ?? container.clientHeight
    const wasZero = lastWidth === 0 && lastHeight === 0
    const widthChanged = lastWidth > 0 && width > 0 && Math.abs(width - lastWidth) / lastWidth > SIGNIFICANT_WIDTH_CHANGE
    if ((wasZero && width > 0 && height > 0) || widthChanged) {
      fontMetricsDirty = true
      if (!wasSuspended) runWhenParserIdle(parserGate, runFit)
    }
    lastWidth = width
    lastHeight = height
    coordinator.request()
  })
  observer.observe(container)

  const handleWindowResize = () => {
    checkSuspension()
    coordinator.request()
  }
  const handleVisible = () => {
    if (!document.hidden) coordinator.request()
  }
  window.addEventListener("resize", handleWindowResize)
  window.addEventListener("focus", handleVisible)
  document.addEventListener("visibilitychange", handleVisible)
  const mountFrame = requestAnimationFrame(() => coordinator.request())
  void document.fonts.ready.then(() => {
    if (!disposed) coordinator.request()
  })

  return {
    coordinator,
    cleanup: () => {
      disposed = true
      cancelParserIdleWork(parserGate)
      cancelAnimationFrame(mountFrame)
      window.removeEventListener("resize", handleWindowResize)
      window.removeEventListener("focus", handleVisible)
      document.removeEventListener("visibilitychange", handleVisible)
      observer.disconnect()
      coordinator.dispose()
    },
  }
}
