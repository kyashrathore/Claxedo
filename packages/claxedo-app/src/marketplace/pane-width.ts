import { createSidePanelSize } from "@/lib/side-panel-size"
import { persistedSignal, preferenceKey } from "@/lib/persisted"

export const PANE_MIN_WIDTH = 360
const PANE_DEFAULT_WIDTH = 420
const PANE_MAX_FRACTION = 0.6

function storedPaneWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= PANE_MIN_WIDTH ? Math.round(value) : undefined
}

export function createMarketplacePanelSize() {
  const [chosen, onChoose] = persistedSignal(
    preferenceKey("marketplace", "detailWidth"),
    PANE_DEFAULT_WIDTH,
    storedPaneWidth,
  )
  return createSidePanelSize({
    chosen,
    onChoose,
    width: (state) =>
      state.phone || state.fullWidth ? state.available : Math.min(chosen(), maxDetailsWidth(state.available)),
    clamp: (width, available) => Math.min(maxDetailsWidth(available), Math.max(PANE_MIN_WIDTH, width)),
  })
}

export function maxDetailsWidth(available: number): number {
  return Math.max(PANE_MIN_WIDTH, Math.round(available * PANE_MAX_FRACTION))
}
