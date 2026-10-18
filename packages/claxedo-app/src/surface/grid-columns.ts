export const GRID_COLUMN_COUNTS = ["1", "2", "3", "4", "5", "6"] as const

export type GridColumns = (typeof GRID_COLUMN_COUNTS)[number]

const DEFAULT_COLUMNS = 2

export function gridColumns(columns: number | undefined): GridColumns {
  const whole = Math.round(columns ?? DEFAULT_COLUMNS)
  const clamped = Math.min(GRID_COLUMN_COUNTS.length, Math.max(1, Number.isFinite(whole) ? whole : DEFAULT_COLUMNS))
  return GRID_COLUMN_COUNTS[clamped - 1] ?? "1"
}
