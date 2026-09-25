import type { Terminal as XTerm } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import { objectProperty } from "./reflect"
import type { RendererHandle } from "./renderer-webgl"
import { resizeSuspended } from "./resize-suspension"

export type Fitter = {
  readonly refresh: () => void
  readonly fit: () => void
  readonly markFontMetricsDirty: () => void
}

function rendererReady(xterm: XTerm): boolean {
  const renderer = objectProperty(objectProperty(objectProperty(xterm, "_core"), "_renderService"), "_renderer")
  return !!objectProperty(renderer, "value")
}

function remeasureFont(xterm: XTerm): void {
  const size = xterm.options.fontSize ?? 14
  xterm.options.fontSize = size + 0.001
  xterm.options.fontSize = size
}

export function createFitter(input: {
  xterm: XTerm
  fitAddon: FitAddon
  renderer: RendererHandle
  disposed: () => boolean
}): Fitter {
  const { xterm, fitAddon, renderer } = input
  let fontMetricsDirty = false

  const refresh = () => {
    if (input.disposed() || !rendererReady(xterm)) return
    xterm.refresh(0, xterm.rows - 1)
    renderer.clearTextureAtlas()
  }

  const fit = () => {
    if (input.disposed() || resizeSuspended() || !rendererReady(xterm)) return
    const remeasure = fontMetricsDirty
    if (remeasure) {
      fontMetricsDirty = false
      remeasureFont(xterm)
    }
    if (fitAddon.proposeDimensions()) fitAddon.fit()
    if (remeasure) refresh()
  }

  return {
    refresh,
    fit,
    markFontMetricsDirty: () => {
      fontMetricsDirty = true
    },
  }
}
