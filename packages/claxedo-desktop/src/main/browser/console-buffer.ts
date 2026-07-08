/**
 * Console ring buffer for a single `BrowserHandle`.
 *
 * Each `BrowserHandle` owns one of these and appends console/exception/log
 * entries from every CDP session (top + flat-attached child sessions) through
 * `append()`. The buffer caps at `MAX_ENTRIES` (2,000 per plan) with FIFO
 * eviction; consumers read via `since(token, { level?, limit? })` or
 * `snapshot()`.
 *
 * `getConsoleLogs` IPC is a *pull* over this buffer, not a live subscription
 * share, so multiple consumers (renderer drawer + MCP polling) never contend
 * on the same event stream. Live streaming is still provided via the
 * per-entry listener callbacks registered on `BrowserHandle`.
 */

export const MAX_CONSOLE_ENTRIES = 2000

export type ConsoleLevel = "log" | "warn" | "error" | "debug" | "info"

/**
 * The `source` tells readers which CDP domain surfaced the entry; useful for
 * filtering out Chromium-internal network/log noise vs. application output.
 */
export type ConsoleSource = "console" | "exception" | "log"

export type ConsoleStackFrame = {
  url?: string
  function?: string
  line?: number
  column?: number
}

export type ConsoleEntry = {
  /** Monotonic id assigned on append; useful as a `since` token. */
  id: number
  /** `Date.now()` at append time (ms). */
  time: number
  level: ConsoleLevel
  /** Stringified args/messages, ANSI / zero-width / unicode-tag stripped. */
  args: string[]
  /** Optional stack — for `Runtime.exceptionThrown` / error entries. */
  stack?: ConsoleStackFrame[]
  /** Which CDP domain dispatched the entry. */
  source: ConsoleSource
  /** CDP session id (top = undefined; flat-attached child frames have one). */
  sessionId?: string
}

export type ConsoleEntryInput = Omit<ConsoleEntry, "id" | "time"> & {
  /** Optional override for tests / replay; defaults to `Date.now()`. */
  time?: number
}

export type ConsoleQuery = {
  /** Return entries with `id > since`. */
  since?: number
  /** Filter to a single level (after sanitization). */
  level?: ConsoleLevel
  /** Cap on number of entries returned (most recent first preserved). */
  limit?: number
}

/**
 * Strip ANSI escape sequences, zero-width code points, and unicode-tag
 * characters from a string. Console output from untrusted pages is an input
 * vector — e.g. a hostile site can dump prompt-injection text in a zero-width
 * envelope that an LLM reads but the user never sees. We normalize before we
 * persist or hand off to MCP.
 *
 * Exposed for direct test coverage of the sanitization itself.
 */
export function sanitizeConsoleString(input: string): string {
  if (!input) return input
  let out = ""
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    // ESC — start of an ANSI CSI/OSC/etc. sequence.
    if (code === 0x1b) {
      // Walk until we hit a terminator (letter in @–~ for CSI, BEL / ESC\\ for OSC, or run out).
      let j = i + 1
      if (j < input.length && input.charCodeAt(j) === 0x5b /* [ */) {
        // CSI: ESC [ ... final-byte (0x40..0x7e)
        j++
        while (j < input.length) {
          const c = input.charCodeAt(j)
          if (c >= 0x40 && c <= 0x7e) {
            j++
            break
          }
          j++
        }
      } else if (j < input.length && input.charCodeAt(j) === 0x5d /* ] */) {
        // OSC: ESC ] ... (BEL | ESC \\)
        j++
        while (j < input.length) {
          const c = input.charCodeAt(j)
          if (c === 0x07) {
            j++
            break
          }
          if (c === 0x1b && j + 1 < input.length && input.charCodeAt(j + 1) === 0x5c) {
            j += 2
            break
          }
          j++
        }
      } else {
        // ESC <single-char> (e.g. ESC M, ESC =)
        if (j < input.length) j++
      }
      i = j - 1
      continue
    }
    // Unicode-tag characters (U+E0000..U+E007F).
    if (code >= 0xd800 && code <= 0xdbff) {
      const high = code
      const low = i + 1 < input.length ? input.charCodeAt(i + 1) : 0
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        if (cp >= 0xe0000 && cp <= 0xe007f) {
          i++ // skip the low surrogate as well
          continue
        }
        // Preserve non-tag supplementary planes verbatim.
        out += input[i]
        out += input[i + 1]!
        i++
        continue
      }
    }
    // Zero-width characters.
    if (
      code === 0x200b || // ZWSP
      code === 0x200c || // ZWNJ
      code === 0x200d || // ZWJ
      code === 0xfeff || // BOM / ZWNBSP
      code === 0x2060 // Word Joiner
    ) {
      continue
    }
    out += input[i]
  }
  return out
}

function sanitizeArgs(args: string[]): string[] {
  return args.map((a) => sanitizeConsoleString(typeof a === "string" ? a : String(a)))
}

export class ConsoleBuffer {
  #entries: ConsoleEntry[] = []
  #nextId = 1
  #cap: number

  constructor(cap = MAX_CONSOLE_ENTRIES) {
    this.#cap = cap
  }

  get size(): number {
    return this.#entries.length
  }

  /** Append an entry; returns the assigned `ConsoleEntry`. Sanitizes `args`. */
  append(input: ConsoleEntryInput): ConsoleEntry {
    const entry: ConsoleEntry = {
      id: this.#nextId++,
      time: input.time ?? Date.now(),
      level: input.level,
      args: sanitizeArgs(input.args ?? []),
      stack: input.stack,
      source: input.source,
      sessionId: input.sessionId,
    }
    this.#entries.push(entry)
    if (this.#entries.length > this.#cap) {
      // Drop the oldest N to stay within cap. Array splice is fine at this scale.
      const overflow = this.#entries.length - this.#cap
      this.#entries.splice(0, overflow)
    }
    return entry
  }

  /** Return a copy of all entries (oldest first). */
  snapshot(): ConsoleEntry[] {
    return this.#entries.slice()
  }

  /** Clear all entries. Called on `render-process-gone` per the state machine. */
  clear(): void {
    this.#entries.length = 0
  }

  /**
   * Return entries matching the query. `since` is an inclusive-greater-than
   * cursor (id > since). Limit truncates the *most recent* N matches.
   */
  query(q: ConsoleQuery = {}): ConsoleEntry[] {
    let out: ConsoleEntry[] = this.#entries
    if (q.since !== undefined) {
      out = out.filter((e) => e.id > q.since!)
    }
    if (q.level !== undefined) {
      out = out.filter((e) => e.level === q.level)
    }
    if (q.limit !== undefined && q.limit >= 0 && out.length > q.limit) {
      out = out.slice(out.length - q.limit)
    }
    return out
  }
}
