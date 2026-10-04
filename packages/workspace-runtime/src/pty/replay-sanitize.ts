/**
 * A replayed buffer is a RECORDING, not live output.
 *
 * Two families of escape sequence are meaningful when they stream from a live
 * program and actively harmful when they are replayed out of a transcript:
 *
 * 1. **Queries.** A terminal ANSWERS these by writing a reply back into the
 *    pty. Replaying `CSI > q` (XTVERSION) makes the reattaching terminal reply
 *    to a program that asked the question minutes ago — and if that program has
 *    exited, the shell now reading the pty receives the reply as typed input
 *    and echoes it. That is the `^[P>|xterm.js(6.1.0-beta.289)^[\` and
 *    `1;95;0c`-shaped junk that appears next to the prompt after a restore.
 *
 * 2. **Mode sets.** Replaying `?1003h` re-arms mouse tracking in the terminal
 *    because a TUI armed it during the recording. The program that wanted those
 *    reports may be long gone, so every subsequent pointer move sprays
 *    `ESC[<35;…M` into the shell. Modes must come from ONE place — the live
 *    preamble built from the emulator that mirrors the running process
 *    (`mode-tracker.ts`) — never from the transcript, which is stale by
 *    definition.
 *
 * Everything else is left byte-for-byte: colours, cursor positioning, erases
 * and text are what make the restored screen look like the one the user left.
 *
 * Applied to the replay only. The LIVE stream keeps its queries and mode sets —
 * those are a running program talking to its terminal, and must go through.
 *
 * ## Why a hand-rolled scanner rather than regexes
 *
 * This runs on the attach hot path over a buffer that can reach the replay cap
 * (megabytes for a TUI transcript). The original implementation was eight
 * sequential `String.replace` passes, each allocating a fresh copy of the whole
 * buffer when it matched — roughly eight full-size intermediates per attach.
 * A single left-to-right scan that copies only the KEPT runs allocates once,
 * and for the common case (nothing to strip) returns the input unchanged with
 * no copy at all.
 */

const ESC = 0x1b
const BEL = 0x07

/**
 * DECSET/DECRST private modes owned by the live preamble. Keyed on the FIRST
 * parameter, matching how programs actually emit them (`CSI ? 1002 ; 1006 h`).
 *
 *   1     application cursor keys      66    application keypad
 *   9     X10 mouse                    1000–1003 mouse tracking levels
 *   1004  focus reporting              1005/1006/1015/1016 mouse encodings
 *   2004  bracketed paste              47/1047/1049 alternate screen
 *
 * Alternate screen is included because which buffer a restore lands in is the
 * restore logic's decision; a stray toggle from the transcript would either
 * hide the restored scrollback or strand the terminal in an unpainted buffer.
 */
function isPreambleOwnedMode(param: number): boolean {
  if (param === 1 || param === 9 || param === 47 || param === 66) return true
  if (param === 2004 || param === 1015 || param === 1016) return true
  // 1000–1099 covers the tracking levels, encodings, focus reporting, and the
  // 1047/1049 alt-screen forms in one range.
  return param >= 1000 && param <= 1099
}

/** Result of examining one escape sequence. */
type Scanned = {
  /** Index just past the sequence, or -1 when it is incomplete. */
  end: number
  /** True when the sequence must not reach a reattaching terminal. */
  drop: boolean
}

/**
 * Parse the CSI starting at `start` (the ESC). Shape:
 *   ESC [ <private 0x3C–0x3F> <params 0x30–0x3B> <intermediates 0x20–0x2F> <final 0x40–0x7E>
 */
function scanCsi(data: string, start: number): Scanned {
  let i = start + 2
  const len = data.length

  let prefix = 0
  if (i < len) {
    const code = data.charCodeAt(i)
    if (code >= 0x3c && code <= 0x3f) {
      prefix = code
      i += 1
    }
  }

  const paramStart = i
  while (i < len) {
    const code = data.charCodeAt(i)
    if (code >= 0x30 && code <= 0x3b) i += 1
    else break
  }
  const paramEnd = i

  let intermediate = 0
  while (i < len) {
    const code = data.charCodeAt(i)
    if (code >= 0x20 && code <= 0x2f) {
      // Only the last intermediate matters for the sequences we classify.
      intermediate = code
      i += 1
    } else break
  }

  if (i >= len) return { end: -1, drop: false }
  const final = data.charCodeAt(i)
  if (final < 0x40 || final > 0x7e) {
    // Not a well-formed CSI; treat the ESC as literal text and move on.
    return { end: start + 1, drop: false }
  }
  const end = i + 1

  const isPrivate = prefix !== 0
  const q = prefix === 0x3f // '?'
  const gt = prefix === 0x3e // '>'
  const lt = prefix === 0x3c // '<'
  const eq = prefix === 0x3d // '='

  // --- queries: the terminal answers these ---------------------------------
  // Device Attributes — CSI c / CSI > c / CSI = c
  if (final === 0x63 /* c */) return { end, drop: true }
  // Device Status Report / cursor position — CSI n / CSI ? n
  if (final === 0x6e /* n */ && (prefix === 0 || q)) return { end, drop: true }
  // XTVERSION — CSI > q. Bare `CSI Ps SP q` is DECSCUSR (cursor style), keep it.
  if (final === 0x71 /* q */ && gt) return { end, drop: true }
  // DECRQM — CSI ? Ps $ p
  if (final === 0x70 /* p */ && intermediate === 0x24 /* $ */) return { end, drop: true }

  // --- kitty keyboard protocol: CSI > u / CSI = u / CSI < u ----------------
  if (final === 0x75 /* u */ && (gt || lt || eq)) return { end, drop: true }

  // --- DECSET/DECRST for preamble-owned modes ------------------------------
  if ((final === 0x68 /* h */ || final === 0x6c /* l */) && q) {
    let first = 0
    let sawDigit = false
    for (let p = paramStart; p < paramEnd; p += 1) {
      const code = data.charCodeAt(p)
      if (code === 0x3b /* ; */) break
      first = first * 10 + (code - 0x30)
      sawDigit = true
    }
    if (sawDigit && isPreambleOwnedMode(first)) return { end, drop: true }
  }

  void isPrivate
  return { end, drop: false }
}

/**
 * Parse a string-terminated sequence (OSC / DCS / APC / PM / SOS) starting at
 * the ESC. Terminated by BEL or ST (`ESC \`).
 */
function scanStringSequence(data: string, start: number, introducer: number): Scanned {
  const len = data.length
  let i = start + 2
  let terminatorEnd = -1
  while (i < len) {
    const code = data.charCodeAt(i)
    if (code === BEL) {
      terminatorEnd = i + 1
      break
    }
    if (code === ESC && i + 1 < len && data.charCodeAt(i + 1) === 0x5c /* \ */) {
      terminatorEnd = i + 2
      break
    }
    i += 1
  }
  if (terminatorEnd === -1) return { end: -1, drop: false }

  const body = data.slice(start + 2, i)

  // DCS `+q…` — XTGETTCAP, answered by the terminal.
  if (introducer === 0x50 /* P */ && body.startsWith("+q")) {
    return { end: terminatorEnd, drop: true }
  }

  // OSC colour QUERY — `OSC <num> ; ?`. The SET form carries a value and stays.
  if (introducer === 0x5d /* ] */) {
    const semi = body.indexOf(";")
    if (semi > 0 && body.length === semi + 2 && body.charCodeAt(semi + 1) === 0x3f /* ? */) {
      let numeric = true
      for (let p = 0; p < semi; p += 1) {
        const code = body.charCodeAt(p)
        if (code < 0x30 || code > 0x39) {
          numeric = false
          break
        }
      }
      if (numeric) return { end: terminatorEnd, drop: true }
    }
  }

  return { end: terminatorEnd, drop: false }
}

/**
 * Strip reply-provoking queries and stale mode sets from a buffer that is about
 * to be replayed to a reattaching terminal.
 *
 * Single pass; returns the input by reference when nothing needed stripping.
 */
export function sanitizeReplay(data: string): string {
  if (!data) return data

  let search = data.indexOf("\x1b")
  if (search === -1) return data

  let kept: string[] | null = null
  let copiedTo = 0
  let i = search

  while (i < data.length) {
    if (data.charCodeAt(i) !== ESC) {
      i += 1
      continue
    }

    const next = i + 1 < data.length ? data.charCodeAt(i + 1) : -1
    let scanned: Scanned
    if (next === 0x5b /* [ */) {
      scanned = scanCsi(data, i)
    } else if (
      next === 0x5d /* ] */ ||
      next === 0x50 /* P */ ||
      next === 0x5f /* _ */ ||
      next === 0x5e /* ^ */ ||
      next === 0x58 /* X */
    ) {
      scanned = scanStringSequence(data, i, next)
    } else {
      // Two-byte escape (ESC c, ESC =, ESC 7, …) or a trailing lone ESC.
      scanned = { end: next === -1 ? -1 : i + 2, drop: false }
    }

    if (scanned.end === -1) {
      // Incomplete at the end of the buffer — keep the fragment verbatim.
      break
    }

    if (scanned.drop) {
      if (!kept) kept = []
      if (i > copiedTo) kept.push(data.slice(copiedTo, i))
      copiedTo = scanned.end
    }
    i = scanned.end
  }

  if (!kept) return data
  if (copiedTo < data.length) kept.push(data.slice(copiedTo))
  void search
  return kept.join("")
}
