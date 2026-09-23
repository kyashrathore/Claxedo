/**
 * Backpressure and batching ceilings for the terminal stream.
 *
 * Extracted from `terminal.tsx` alongside the colour resolver to bring that file
 * back under its size ceiling. These are tuning constants with no behaviour, so
 * they read better next to each other than buried above a 1200-line component —
 * and the perf numbers that justify them stay attached to the values.
 */

// Measured against the perf harness: scrolling_top_small_region 18.04ms,
// sync_medium_cells 11.75ms, unicode 9.18ms.
export const MAX_PENDING_BYTES = 128 * 1024 * 1024
export const MAX_STREAM_BYTES = 128 * 1024 * 1024
export const MAX_BATCH_BYTES = 4 * 1024 * 1024
export const MAX_BATCH_ITEMS = 8192
export const MAX_DROPPED_CHUNKS = 1_000_000
export const OPEN_RESIZE_SETTLE_MS = 220
