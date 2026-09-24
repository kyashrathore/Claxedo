import { persistedSignal, preferenceKey } from "@/lib/persisted"

export const PANE_MIN_WIDTH = 360
export const PANE_DEFAULT_WIDTH = 420
export const PANE_MAX_FRACTION = 0.6

function readWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= PANE_MIN_WIDTH ? Math.round(value) : undefined
}

export function createPaneWidth() {
  return persistedSignal<number>(preferenceKey("marketplace", "detailWidth"), PANE_DEFAULT_WIDTH, readWidth)
}
