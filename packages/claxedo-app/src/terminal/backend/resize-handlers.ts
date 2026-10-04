import type { Terminal as XTerm } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import { createResizeCoordinator, type ResizeCoordinator } from "./resize-coordinator"
import { cancelParserIdleWork, runWhenParserIdle, type ParserGate } from "./parser-gate"
import type { RendererHandle } from "./renderer-webgl"
import { createFitter, type Fitter } from "./resize-fit"
import { trackSuspension, type SuspensionTracker } from "./resize-suspension"
import { listenResizeTriggers } from "./resize-triggers"

export type ResizeHandlers = {
  readonly coordinator: ResizeCoordinator
  readonly cleanup: () => void
}

type ResizeHandlersInput = {
  container: HTMLDivElement
  xterm: XTerm
  fitAddon: FitAddon
  renderer: RendererHandle
  parserGate: ParserGate
  onResize: (cols: number, rows: number) => void
}

const SIGNIFICANT_WIDTH_CHANGE = 0.2

function observeHost(input: {
  container: HTMLDivElement
  fitter: Fitter
  suspension: SuspensionTracker
  coordinator: ResizeCoordinator
  parserGate: ParserGate
  disposed: () => boolean
}): ResizeObserver {
  const { container, fitter, suspension, coordinator, parserGate } = input
  let lastWidth = 0
  let lastHeight = 0
  const observer = new ResizeObserver((entries) => {
    if (input.disposed() || !container.isConnected) return
    suspension.check()
    const rect = entries[0]?.contentRect
    const width = rect?.width ?? container.clientWidth
    const height = rect?.height ?? container.clientHeight
    const wasZero = lastWidth === 0 && lastHeight === 0
    const widthChanged =
      lastWidth > 0 && width > 0 && Math.abs(width - lastWidth) / lastWidth > SIGNIFICANT_WIDTH_CHANGE
    if ((wasZero && width > 0 && height > 0) || widthChanged) {
      fitter.markFontMetricsDirty()
      if (!suspension.suspended()) runWhenParserIdle(parserGate, fitter.fit)
    }
    lastWidth = width
    lastHeight = height
    coordinator.request()
  })
  observer.observe(container)
  return observer
}

export function setupResizeHandlers(input: ResizeHandlersInput): ResizeHandlers {
  const { container, xterm, fitAddon, renderer, parserGate } = input
  let disposed = false
  const isDisposed = () => disposed
  const fitter = createFitter({ xterm, fitAddon, renderer, disposed: isDisposed })
  const coordinator = createResizeCoordinator({
    fit: () => runWhenParserIdle(parserGate, fitter.fit),
    measure: () => ({ width: container.clientWidth, height: container.clientHeight }),
    size: () => ({ cols: xterm.cols, rows: xterm.rows }),
    refresh: fitter.refresh,
    notify: input.onResize,
  })
  const suspension = trackSuspension(coordinator)
  const observer = observeHost({ container, fitter, suspension, coordinator, parserGate, disposed: isDisposed })
  const stopTriggers = listenResizeTriggers({ coordinator, checkSuspension: suspension.check, disposed: isDisposed })

  return {
    coordinator,
    cleanup: () => {
      disposed = true
      cancelParserIdleWork(parserGate)
      stopTriggers()
      observer.disconnect()
      coordinator.dispose()
    },
  }
}
