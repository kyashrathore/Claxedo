/**
 * Process resource-stat formatters. Split out of `utils/text.ts` so that
 * module stays scoped to string helpers (collapse/clip/errorText); memory and
 * CPU formatting are process-diagnostics concerns, not text utilities.
 */

/** Format RSS kilobytes as MB (0 decimals above 1 GB, 1 decimal below). */
export const formatMB = (rssKb: number) => `${(rssKb / 1024).toFixed(rssKb >= 1024 * 1024 ? 0 : 1)} MB`

/** Format a CPU percentage (0 decimals at 10%+, 1 decimal below). */
export const formatCPU = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}%`
