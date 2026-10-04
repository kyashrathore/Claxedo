import type { SidePanelSizeInput } from "../lib/side-panel-size"

export const PANEL_MIN_WIDTH = 360
export const NAVIGATOR_MIN_WIDTH = 220

const NAVIGATOR_DEFAULT_WIDTH = 280
const NAVIGATOR_DEFAULT_FRACTION = 0.45
const NAVIGATOR_MAX_FRACTION = 0.6

const MIN_READABLE_CONTENT_WIDTH = 300

function readableLimit(available: number): number {
  return Math.max(
    PANEL_MIN_WIDTH,
    available - Math.min(MIN_READABLE_CONTENT_WIDTH, Math.max(0, available - PANEL_MIN_WIDTH)),
  )
}

export function maxPanelWidth(available: number): number {
  return Math.min(Math.max(PANEL_MIN_WIDTH, Math.floor(available * 0.86)), readableLimit(available))
}

function defaultPanelWidth(available: number): number {
  return Math.min(Math.max(PANEL_MIN_WIDTH, Math.floor(available * 0.7)), readableLimit(available))
}

export function clampPanelWidth(width: number, available: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(maxPanelWidth(available), width))
}

export function restingPanelWidth(input: SidePanelSizeInput): number {
  if (input.phone || input.fullWidth) return input.available
  return Math.min(
    input.chosen ?? clampPanelWidth(defaultPanelWidth(input.available), input.available),
    maxPanelWidth(input.available),
  )
}

export function workbenchInset(input: {
  readonly open: boolean
  readonly phone: boolean
  readonly fullWidth: boolean
  readonly width: number
}): number {
  return !input.open || input.phone || input.fullWidth ? 0 : input.width
}

export function maxNavigatorWidth(row: number): number {
  return Math.floor(row * NAVIGATOR_MAX_FRACTION)
}

export function clampNavigatorWidth(width: number, row: number): number {
  return Math.min(maxNavigatorWidth(row), Math.max(NAVIGATOR_MIN_WIDTH, width))
}

export function restingNavigatorWidth(row: number, chosen: number | null): number {
  if (chosen === null) return Math.min(NAVIGATOR_DEFAULT_WIDTH, row * NAVIGATOR_DEFAULT_FRACTION)
  return clampNavigatorWidth(chosen, row)
}
