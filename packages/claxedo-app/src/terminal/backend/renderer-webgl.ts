import type { ITerminalAddon, Terminal as XTerm } from "@xterm/xterm"
import type { RendererBudget } from "./renderer-budget"

export type RendererHandle = {
  readonly kind: () => "webgl" | "dom"
  readonly clearTextureAtlas: () => void
  readonly dispose: () => void
}

type WebglAddon = ITerminalAddon & {
  clearTextureAtlas?: () => void
  onContextLoss?: (fn: () => void) => void
}

export function loadRenderer(xterm: XTerm, budget: RendererBudget): RendererHandle {
  let addon: WebglAddon | undefined
  let disposed = false
  let counted = false

  const release = () => {
    addon?.dispose()
    addon = undefined
    if (counted) budget.release()
    counted = false
  }

  const attach = (WebglAddon: new () => WebglAddon) => {
    if (disposed || !budget.acquire()) return
    counted = true
    addon = new WebglAddon()
    xterm.loadAddon(addon)
    addon.onContextLoss?.(release)
  }

  if (!budget.preferDom() && budget.supported()) {
    void import("@xterm/addon-webgl").then(({ WebglAddon }) => attach(WebglAddon))
  }

  return {
    kind: () => (addon ? "webgl" : "dom"),
    clearTextureAtlas: () => addon?.clearTextureAtlas?.(),
    dispose: () => {
      disposed = true
      release()
    },
  }
}
