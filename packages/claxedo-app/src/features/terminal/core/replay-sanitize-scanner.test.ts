import { describe, expect, test } from "bun:test"
import { sanitizeReplay } from "./replay-sanitize"

/**
 * Edges specific to the single-pass scanner that replaced the eight-regex
 * implementation. The behavioural suite lives in `replay-sanitize.test.ts` and
 * carried over unchanged — these cover the scanner's own failure modes.
 */
const ESC = "\x1b"

describe("sanitizeReplay — single-pass scanner edges", () => {
  test("preserves styled content when nothing needs stripping", () => {
    const input = `${ESC}[1;32mgreen${ESC}[0m plain text`
    expect(sanitizeReplay(input)).toBe(input)
  })

  test("keeps an incomplete sequence at the end of the buffer verbatim", () => {
    // A replay can be cut anywhere; a trailing fragment must not be eaten,
    // because xterm reassembles it against whatever arrives next.
    expect(sanitizeReplay(`text${ESC}[?100`)).toBe(`text${ESC}[?100`)
    expect(sanitizeReplay(`text${ESC}`)).toBe(`text${ESC}`)
    expect(sanitizeReplay(`text${ESC}]0;untermin`)).toBe(`text${ESC}]0;untermin`)
  })

  test("keeps a mode whose first parameter is not preamble-owned", () => {
    // 25 = cursor visibility, 7 = autowrap: the transcript legitimately owns these.
    expect(sanitizeReplay(`a${ESC}[?25lb`)).toBe(`a${ESC}[?25lb`)
    expect(sanitizeReplay(`a${ESC}[?7lb`)).toBe(`a${ESC}[?7lb`)
  })

  test("drops on the FIRST parameter of a combined list, as programs emit them", () => {
    expect(sanitizeReplay(`a${ESC}[?1002;1006hb`)).toBe("ab")
  })

  test("keeps a malformed CSI rather than swallowing the rest of the buffer", () => {
    const malformed = `a${ESC}[b`
    expect(sanitizeReplay(malformed)).toBe(malformed)
  })

  test("distinguishes DECSCUSR from XTVERSION — both end in q", () => {
    expect(sanitizeReplay(`a${ESC}[2 qb`)).toBe(`a${ESC}[2 qb`)
    expect(sanitizeReplay(`a${ESC}[>0qb`)).toBe("ab")
  })

  test("handles back-to-back droppable sequences", () => {
    expect(sanitizeReplay(`a${ESC}[?1003h${ESC}[?1006h${ESC}[>0qb`)).toBe("ab")
  })

  test("handles a drop at the very start and the very end", () => {
    expect(sanitizeReplay(`${ESC}[?1003hmiddle${ESC}[c`)).toBe("middle")
  })

  test("keeps an OSC colour SET while dropping the QUERY, by shape not position", () => {
    const set = `${ESC}]11;rgb:00/00/00${ESC}\\`
    expect(sanitizeReplay(`a${set}b`)).toBe(`a${set}b`)
    expect(sanitizeReplay(`a${ESC}]11;?${ESC}\\b`)).toBe("ab")
  })

  test("preserves all retained content in a large TUI-shaped buffer", () => {
    const unit = `${ESC}[1;32mline${ESC}[0m${ESC}[?1003h${ESC}[>0q\r\n`
    const big = unit.repeat(20000)
    const out = sanitizeReplay(big)
    expect(out).toBe(`${ESC}[1;32mline${ESC}[0m\r\n`.repeat(20000))
  })
})
