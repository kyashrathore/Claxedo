/**
 * ED3 (`ESC [ 3 J`) — erase scrollback. When a program emits it we drop the
 * retained history up to that point, because the user asked for a clean slate.
 *
 * Deliberately NOT matched: RIS (`ESC c`, full reset). Fullscreen TUIs emit RIS
 * on repaint, and treating it as a scrollback clear would wipe history every
 * time an agent redrew its frame.
 */
export const CLEAR_SCROLLBACK = "\x1b[3J"

/**
 * The content after the LAST clear in `data` — what survives the erase.
 *
 * When the sequence was split across chunks the caller has already been told a
 * clear happened (via the scanner) but this chunk holds only the tail of the
 * sequence; `carry` lets the caller pass the previous chunk's retained tail so
 * the split sequence is still recognised and stripped.
 */
export function extractContentAfterClear(data: string, carry = "") {
  const combined = carry + data
  const index = combined.lastIndexOf(CLEAR_SCROLLBACK)
  if (index === -1) return data
  const after = combined.slice(index + CLEAR_SCROLLBACK.length)
  // `after` can only reach back into `carry` when the sequence straddled the
  // boundary, in which case everything before it was already dropped.
  return after
}
