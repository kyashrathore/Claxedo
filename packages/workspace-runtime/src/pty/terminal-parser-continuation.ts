import { rec } from "../json-value"

// Keep a pending control string bounded independently of retained screen rows.
// Oversize state is unavailable for checkpoints until the parser returns to
// ground; never return a truncated control sequence as a valid continuation.
const MAX_CONTINUATION_UNITS = 1_048_576

export function createTerminalParserContinuation(terminal: unknown) {
  const input = rec(rec(rec(terminal)?._core)?._inputHandler)
  const parser = rec(input?._parser)
  const table = rec(parser?._transitions)?.table
  if (!parser || !(table instanceof Uint16Array) || parser.currentState !== 0) {
    throw new Error("Pinned xterm parser continuation internals are unavailable or already active")
  }
  let state = 0
  let pending = ""
  let unavailable: string | undefined
  let highSurrogate = ""

  return {
    /** Call after this exact chunk has been parsed by the host emulator. */
    observe(data: string) {
      // Mirror native string decoding: an incomplete UTF-16 pair has not yet
      // reached the parser. Decoder state is captured separately in checkpoints.
      let decoded = highSurrogate + data
      const last = decoded.charCodeAt(decoded.length - 1)
      highSurrogate = last >= 0xd800 && last <= 0xdbff ? decoded.slice(-1) : ""
      if (highSurrogate) decoded = decoded.slice(0, -1)
      if (parser.currentState === 0) {
        state = 0
        pending = ""
        unavailable = undefined
        return
      }
      for (const character of decoded) {
        const code = character.codePointAt(0)!
        const transition = table[(state << 8) | (code < 160 ? code : 160)]
        const action = transition >> 8
        let next = transition & 255
        if (code === 27) {
          pending = character
          next = 1 // OSC/DCS/APC unhook with ESC enters native ESCAPE state.
        } else if (next === 0) {
          pending = ""
        } else if (action !== 3 && !(action === 0 && next === state)) {
          // EXECUTE controls already affected the captured screen (e.g. LF).
          // Replaying them would apply those effects a second time.
          if (state === 0 || (code >= 128 && code < 160 && next !== state)) pending = character
          else if (!unavailable) pending += character
        }
        state = next
        if (pending.length > MAX_CONTINUATION_UNITS) {
          unavailable = "Terminal parser continuation exceeds checkpoint limit"
          pending = ""
        }
      }
      if (state !== parser.currentState) {
        unavailable = "Terminal parser continuation disagrees with the host emulator"
      }
    },
    read() {
      if (unavailable) throw new Error(unavailable)
      return pending
    },
  }
}
