import { safeStartIndex } from "./replay-safe-slice"
import { sanitizeReplay } from "./replay-sanitize"

// Keep this small enough to avoid localStorage quota issues (which can
// permanently disable persistence in some browsers once it starts failing).
// Terminal history should primarily be restored from the PTY stream, not from
// multi-megabyte localStorage blobs.
export const MAX_RESTORE_BUFFER_BYTES = 256 * 1024
export const MAX_PERSIST_BUFFER_BYTES = 256 * 1024

/**
 * Trim to the last `max` code units, moving the cut to a safe boundary so the
 * kept tail never starts mid-escape (which xterm prints as literal junk) or on
 * a lone surrogate.
 */
function keepTail(value: string, max: number) {
  if (value.length <= max) return value
  return value.slice(safeStartIndex(value, value.length - max))
}

export function prepareRestoreBuffer(value?: string) {
  if (!value) return { value: undefined, trimmed: false }
  // Sanitize on the way OUT as well as in, so snapshots persisted by an older
  // build (which still contain the program's queries and mode sets) cannot
  // re-arm mouse tracking or provoke an answer-back into a shell that never
  // asked. Cheap: a no-op for any buffer without an ESC.
  const clean = sanitizeReplay(value)
  if (clean.length <= MAX_RESTORE_BUFFER_BYTES) return { value: clean, trimmed: false }
  return { value: keepTail(clean, MAX_RESTORE_BUFFER_BYTES), trimmed: true }
}

export function preparePersistBuffer(value: string) {
  if (!value) return value
  // A persisted snapshot is a RECORDING. Strip the sequences that only make
  // sense live — terminal queries (which the next mount would answer into a
  // pty whose program has moved on) and mode sets (which belong to the live
  // preamble from the PTY host, not to a transcript).
  return keepTail(sanitizeReplay(value), MAX_PERSIST_BUFFER_BYTES)
}
