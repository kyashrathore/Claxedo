export const PANEL_MIN_WIDTH = 360
export const PANEL_MOTION_MS = 120
export const PANEL_CLOSE_GRACE_MS = PANEL_MOTION_MS + 20
export const PANEL_MOTION = `transform ${PANEL_MOTION_MS}ms cubic-bezier(0.2, 0, 0, 1)`
export const PANEL_RESIZE_KEY_STEP = 24
export const PANEL_BORDER_WIDTH = 1
export const NAVIGATOR_MIN_WIDTH = 220

const NAVIGATOR_DEFAULT_WIDTH = 280
const NAVIGATOR_DEFAULT_FRACTION = 0.45
const NAVIGATOR_MAX_FRACTION = 0.6

const MIN_READABLE_CONTENT_WIDTH = 300

export type PanelWidthInput = {
  readonly available: number
  readonly phone: boolean
  readonly fullWidth: boolean
  readonly chosen: number | null
}

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

export function restingPanelWidth(input: PanelWidthInput): number {
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
