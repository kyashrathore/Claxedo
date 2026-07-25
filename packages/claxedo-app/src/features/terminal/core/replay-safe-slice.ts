/**
 * Cutting a PTY stream at an arbitrary offset.
 *
 * The PTY buffer and the on-disk history are JS strings that get truncated from
 * the head to enforce a size cap, and the replay is chunked for the socket. All
 * three cut at an offset chosen by arithmetic, which can land in the middle of
 * something indivisible:
 *
 *  - **a surrogate pair** — the halves are lone surrogates, which are not valid
 *    UTF-8. A WebSocket text frame carrying one is malformed, and a `writeFile`
 *    of one emits U+FFFD. Cutting between the two halves loses the codepoint.
 *  - **an escape sequence** — a buffer that begins mid-`CSI` hands xterm a
 *    sequence it cannot complete; the parser resynchronises by printing the
 *    tail as literal text, which is how "35;72;51M"-shaped junk appears at the
 *    top of restored scrollback. A buffer that *ends* mid-escape is harmless to
 *    xterm (it buffers partial sequences across writes) but must not be split
 *    inside a surrogate pair.
 *
 * These helpers move a proposed cut to the nearest safe point. They are
 * deliberately conservative: when in doubt they discard a little more than
 * necessary, because a few dropped bytes at the head of scrollback are
 * invisible while a corrupted escape sequence is not.
 */

const ESC = "\x1b"

/** Longest escape sequence we will scan forward past when repairing a head cut. */
const MAX_ESCAPE_SCAN = 128

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Adjust a head-truncation offset so the retained tail starts on a safe
 * boundary: never on the low half of a surrogate pair, and never inside an
 * escape sequence.
 *
 * Returns the index the caller should slice from. It only ever moves forward,
 * so it can never grow the retained text past the requested cap.
 */
export function safeStartIndex(text: string, index: number): number {
  if (index <= 0) return 0
  if (index >= text.length) return text.length

  let start = index

  // A cut between the halves of a surrogate pair leaves a lone low surrogate.
  if (isLowSurrogate(text.charCodeAt(start))) start += 1

  // Walk back far enough to see whether `start` sits inside an escape sequence.
  // Escapes are short; scanning a bounded window keeps this O(1) per trim.
  const windowStart = Math.max(0, start - MAX_ESCAPE_SCAN)
  const escIndex = text.lastIndexOf(ESC, start - 1)
  if (escIndex === -1 || escIndex < windowStart) return start

  // ESC found behind us — is it still open at `start`? A sequence is closed by
  // its final byte; if the terminator appears between the ESC and our cut, the
  // sequence completed before the cut and the cut is already safe.
  const end = escapeSequenceEnd(text, escIndex)
  if (end !== -1 && end <= start) return start

  // The cut is inside an unterminated escape. Drop the whole partial sequence:
  // resume after its terminator when we can see one, else after the scan window
  // (a run of escape-looking bytes longer than any real sequence is garbage).
  if (end !== -1) return end
  const limit = Math.min(text.length, start + MAX_ESCAPE_SCAN)
  for (let i = start; i < limit; i += 1) {
    if (isEscapeFinal(text, escIndex, i)) return i + 1
  }
  return limit
}

/**
 * Index just past the end of the escape sequence starting at `escIndex`, or -1
 * when the sequence is still open at the end of `text`.
 */
function escapeSequenceEnd(text: string, escIndex: number): number {
  const limit = Math.min(text.length, escIndex + MAX_ESCAPE_SCAN)
  for (let i = escIndex + 1; i < limit; i += 1) {
    if (isEscapeFinal(text, escIndex, i)) return i + 1
  }
  return -1
}

/**
 * Whether `i` is the final byte of the escape sequence introduced at `escIndex`.
 *
 * Covers the two families that carry payloads long enough to be cut in half:
 *  - CSI (`ESC [` … final byte in 0x40–0x7E)
 *  - OSC / DCS / APC / PM / SOS (`ESC ]` / `P` / `_` / `^` / `X` … BEL or ST)
 * Anything else after ESC is a two-byte sequence, so the byte after ESC ends it.
 */
function isEscapeFinal(text: string, escIndex: number, i: number): boolean {
  const introducer = text[escIndex + 1]
  const ch = text.charCodeAt(i)

  if (introducer === "[") {
    if (i === escIndex + 1) return false
    return ch >= 0x40 && ch <= 0x7e
  }

  if (introducer === "]" || introducer === "P" || introducer === "_" || introducer === "^" || introducer === "X") {
    if (i === escIndex + 1) return false
    if (ch === 0x07) return true // BEL
    // ST is ESC \ — the backslash is the final byte.
    return text[i] === "\\" && text[i - 1] === ESC
  }

  // Two-byte escape (ESC c, ESC =, ESC 7, …): the byte after ESC ends it.
  return i === escIndex + 1
}

/**
 * Adjust a chunk-boundary offset so a chunk never ends between the halves of a
 * surrogate pair. Used when splitting a replay across socket sends: xterm
 * reassembles escape sequences across writes on its own, but a lone surrogate
 * makes the frame itself malformed.
 *
 * Returns the index the chunk should end at; only ever moves backward, so
 * chunks stay within their size budget.
 */
export function safeChunkEnd(text: string, index: number): number {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  if (isHighSurrogate(text.charCodeAt(index - 1))) return index - 1
  return index
}

/**
 * Head-truncate `text` to at most `max` code units, cutting on a safe boundary.
 * The result may be slightly shorter than `max`; it is never longer.
 */
export function safeTrimStart(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  return text.slice(safeStartIndex(text, text.length - max))
}
