export const PANEL_MIN_WIDTH = 360
export const PANEL_MOTION_MS = 120
export const PANEL_CLOSE_GRACE_MS = PANEL_MOTION_MS + 20
export const PANEL_MOTION = `transform ${PANEL_MOTION_MS}ms cubic-bezier(0.2, 0, 0, 1)`
export const PANEL_RESIZE_KEY_STEP = 24
export const PANEL_PHONE_MAX_WIDTH = 767

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
