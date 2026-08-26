/**
 * Live terminal-mode truth, tracked on the server.
 *
 * Only control sequences can change the modes a newly attached renderer needs.
 * Feeding every byte of terminal output through a second headless xterm made
 * ordinary output pay for a full parser and screen buffer twice: once here and
 * once in the renderer. The scanner below skips plain text in native
 * `indexOf`, parses only complete control sequences, and carries an incomplete
 * sequence across PTY chunks. It deliberately owns modes, never screen state.
 */

const ESC = "\x1b"
const BEL = "\x07"

export type ModeTracker = {
  /** Feed a chunk of PTY output. Parsed synchronously. */
  feed(data: string): void
  /** Retained for the PTY contract; mode parsing is geometry-independent. */
  resize(cols: number, rows: number): void
  /** Bytes that bring a freshly attached terminal to the live input modes. */
  buildPreamble(): string
  dispose(): void
}

type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any"

type ModeState = {
  applicationCursorKeys: boolean
  applicationKeypad: boolean
  bracketedPaste: boolean
  insert: boolean
  origin: boolean
  reverseWraparound: boolean
  sendFocus: boolean
  showCursor: boolean
  wraparound: boolean
  mouseTracking: MouseTracking
  kittyFlags: number
}

const defaults = (): ModeState => ({
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: false,
  insert: false,
  origin: false,
  reverseWraparound: false,
  sendFocus: false,
  showCursor: true,
  wraparound: true,
  mouseTracking: "none",
  kittyFlags: 0,
})

/** Maximum incomplete OSC/DCS payload retained between reads. */
const MAX_CARRY = 64 * 1024

export function createModeTracker(_cols: number, _rows: number): ModeTracker {
  let state = defaults()
  const kittyStack: number[] = []
  let carry = ""
  let disposed = false

  const privateMode = (value: number, enabled: boolean) => {
    switch (value) {
      case 1:
        state.applicationCursorKeys = enabled
        break
      case 6:
        state.origin = enabled
        break
      case 7:
        state.wraparound = enabled
        break
      case 25:
        state.showCursor = enabled
        break
      case 45:
        state.reverseWraparound = enabled
        break
      case 66:
        state.applicationKeypad = enabled
        break
      case 1004:
        state.sendFocus = enabled
        break
      case 2004:
        state.bracketedPaste = enabled
        break
      case 9:
      case 1000:
      case 1002:
      case 1003: {
        const level: MouseTracking =
          value === 9 ? "x10" : value === 1000 ? "vt200" : value === 1002 ? "drag" : "any"
        if (enabled) state.mouseTracking = level
        else state.mouseTracking = "none"
        break
      }
      // Alternate screen, SGR mouse encoding, synchronized output, and all
      // visual-only modes intentionally remain outside the reconnect preamble.
    }
  }

  const kitty = (prefix: string, params: number[]) => {
    const flags = Number.isSafeInteger(params[0]) ? Math.max(0, params[0] ?? 0) : 0
    if (prefix === ">") {
      kittyStack.push(state.kittyFlags)
      state.kittyFlags = flags
      return
    }
    if (prefix === "<") {
      const count = Math.max(1, flags || 1)
      for (let index = 0; index < count; index += 1) {
        if (kittyStack.length === 0) break
        state.kittyFlags = kittyStack.pop() ?? 0
      }
      return
    }
    if (prefix !== "=") return
    switch (params[1] ?? 1) {
      case 2:
        state.kittyFlags |= flags
        break
      case 3:
        state.kittyFlags &= ~flags
        break
      default:
        state.kittyFlags = flags
        break
    }
  }

  const resetModes = (hard: boolean) => {
    const mouseTracking = state.mouseTracking
    state = defaults()
    if (!hard) state.mouseTracking = mouseTracking
    kittyStack.length = 0
  }

  const parseCsi = (sequence: string) => {
    const final = sequence.at(-1)
    if (!final) return
    const body = sequence.slice(2, -1)
    if (body === "!" && final === "p") {
      resetModes(false)
      return
    }
    const prefix = body[0] === "?" || body[0] === ">" || body[0] === "<" || body[0] === "=" ? body[0] : ""
    const paramsText = prefix ? body.slice(1) : body
    // Ignore intermediates and malformed parameter bytes. They cannot be one
    // of the mode sequences owned here.
    if (!/^[0-9;]*$/.test(paramsText)) return
    const params = paramsText === "" ? [0] : paramsText.split(";").map((part) => Number.parseInt(part || "0", 10))
    if (final === "u") {
      kitty(prefix, params)
      return
    }
    if (final !== "h" && final !== "l") return
    const enabled = final === "h"
    if (prefix === "?") {
      for (const value of params) privateMode(value, enabled)
      return
    }
    if (!prefix && params.includes(4)) state.insert = enabled
  }

  const scan = (chunk: string) => {
    if (disposed || (!chunk && !carry)) return
    const data = carry + chunk
    carry = ""
    let cursor = 0

    while (cursor < data.length) {
      const start = data.indexOf(ESC, cursor)
      if (start < 0) return
      if (start + 1 >= data.length) {
        carry = data.slice(start)
        return
      }
      const kind = data[start + 1]
      if (kind === "[") {
        let end = start + 2
        while (end < data.length) {
          const code = data.charCodeAt(end)
          if (code >= 0x40 && code <= 0x7e) break
          end += 1
        }
        if (end >= data.length) {
          carry = data.slice(start, start + MAX_CARRY)
          return
        }
        parseCsi(data.slice(start, end + 1))
        cursor = end + 1
        continue
      }
      if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
        let end = start + 2
        let complete = false
        while (end < data.length) {
          if (data[end] === BEL) {
            end += 1
            complete = true
            break
          }
          if (data[end] === ESC && data[end + 1] === "\\") {
            end += 2
            complete = true
            break
          }
          end += 1
        }
        if (!complete) {
          // An unbounded title/payload must not become an unbounded per-PTY
          // carry. Dropping an oversized incomplete visual sequence can only
          // make mode state slightly stale; retaining terminal output cannot.
          carry = data.length - start <= MAX_CARRY ? data.slice(start) : ""
          return
        }
        cursor = end
        continue
      }
      if (kind === "=") state.applicationKeypad = true
      if (kind === ">") state.applicationKeypad = false
      if (kind === "c") resetModes(true)
      cursor = start + 2
    }
  }

  return {
    feed: scan,
    resize() {},
    buildPreamble() {
      const parts: string[] = []
      if (state.applicationCursorKeys) parts.push(`${ESC}[?1h`)
      if (state.applicationKeypad) parts.push(`${ESC}[?66h`)
      if (state.bracketedPaste) parts.push(`${ESC}[?2004h`)
      if (state.insert) parts.push(`${ESC}[4h`)
      if (state.origin) parts.push(`${ESC}[?6h`)
      if (state.reverseWraparound) parts.push(`${ESC}[?45h`)
      if (state.sendFocus) parts.push(`${ESC}[?1004h`)
      if (!state.showCursor) parts.push(`${ESC}[?25l`)
      if (!state.wraparound) parts.push(`${ESC}[?7l`)
      switch (state.mouseTracking) {
        case "x10": parts.push(`${ESC}[?9h`); break
        case "vt200": parts.push(`${ESC}[?1000h`); break
        case "drag": parts.push(`${ESC}[?1002h`); break
        case "any": parts.push(`${ESC}[?1003h`); break
      }
      if (state.kittyFlags > 0) parts.push(`${ESC}[=${state.kittyFlags};1u`)
      return parts.join("")
    },
    dispose() {
      disposed = true
      carry = ""
      kittyStack.length = 0
    },
  }
}
