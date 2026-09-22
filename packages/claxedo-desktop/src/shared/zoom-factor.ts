/**
 * Chromium's HostZoomMap clamps every factor to [0.25, 5], so a wider range
 * here would let the renderer's own record of the zoom drift from what the
 * page shows.
 */
export const ZOOM_FACTOR_MIN = 0.25
export const ZOOM_FACTOR_MAX = 5

export function clampZoomFactor(factor: number): number {
  return Math.min(Math.max(factor, ZOOM_FACTOR_MIN), ZOOM_FACTOR_MAX)
}
