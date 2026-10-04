import { describe, expect, test } from "bun:test"
import { sanitizeReplay } from "./replay-sanitize"

const ESC = "\x1b"
const BEL = "\x07"
const ST = `${ESC}\\`

describe("sanitizeReplay — queries that would provoke a reply", () => {
  test("strips primary Device Attributes", () => {
    expect(sanitizeReplay(`before${ESC}[cafter`)).toBe("beforeafter")
  })

  test("strips secondary Device Attributes", () => {
    expect(sanitizeReplay(`a${ESC}[>0cb`)).toBe("ab")
  })

  test("strips XTVERSION — the one that produced the observed junk", () => {
    // Claude Code asks this at startup; replaying it made the terminal answer
    // into a shell, which echoed `^[P>|xterm.js(...)^[\` next to the prompt.
    expect(sanitizeReplay(`x${ESC}[>0qy`)).toBe("xy")
  })

  test("strips cursor position requests", () => {
    expect(sanitizeReplay(`a${ESC}[6nb`)).toBe("ab")
  })

  test("strips DECRQM mode requests", () => {
    expect(sanitizeReplay(`a${ESC}[?2026$pb`)).toBe("ab")
  })

  test("strips XTGETTCAP DCS requests with an ST terminator", () => {
    expect(sanitizeReplay(`a${ESC}P+q544e${ST}b`)).toBe("ab")
  })

  test("strips XTGETTCAP DCS requests with a BEL terminator", () => {
    expect(sanitizeReplay(`a${ESC}P+q544e${BEL}b`)).toBe("ab")
  })

  test("strips OSC colour QUERIES but keeps OSC colour SETS", () => {
    expect(sanitizeReplay(`a${ESC}]10;?${BEL}b`)).toBe("ab")
    const set = `${ESC}]10;rgb:ff/ff/ff${BEL}`
    expect(sanitizeReplay(`a${set}b`)).toBe(`a${set}b`)
  })
})

describe("sanitizeReplay — mode sets the live preamble owns", () => {
  test("strips mouse tracking, the source of the 35;NN;NNM junk", () => {
    expect(sanitizeReplay(`a${ESC}[?1003hb`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[?1000hb`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[?9hb`)).toBe("ab")
  })

  test("strips mouse encodings", () => {
    expect(sanitizeReplay(`a${ESC}[?1006hb`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[?1015hb`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[?1016hb`)).toBe("ab")
  })

  test("strips a combined parameter list in one go", () => {
    expect(sanitizeReplay(`a${ESC}[?1002;1006hb`)).toBe("ab")
  })

  test("strips focus reporting and bracketed paste", () => {
    expect(sanitizeReplay(`a${ESC}[?1004hb`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[?2004hb`)).toBe("ab")
  })

  test("strips the kitty keyboard protocol in all three forms", () => {
    expect(sanitizeReplay(`a${ESC}[>7ub`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[=0;1ub`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[<255ub`)).toBe("ab")
  })

  test("strips alternate-screen toggles — the restore logic owns the buffer", () => {
    expect(sanitizeReplay(`a${ESC}[?1049hb`)).toBe("ab")
    expect(sanitizeReplay(`a${ESC}[?47lb`)).toBe("ab")
  })

  test("strips the disarm form too, so a transcript cannot turn modes off either", () => {
    expect(sanitizeReplay(`a${ESC}[?1003lb`)).toBe("ab")
  })
})

describe("sanitizeReplay — everything that makes the screen look right is kept", () => {
  test("keeps SGR colour and style", () => {
    const styled = `${ESC}[1;32mgreen${ESC}[0m ${ESC}[38;5;196mred${ESC}[0m`
    expect(sanitizeReplay(styled)).toBe(styled)
  })

  test("keeps cursor positioning and erases", () => {
    const draw = `${ESC}[10;20H${ESC}[2K${ESC}[Jtext`
    expect(sanitizeReplay(draw)).toBe(draw)
  })

  test("keeps DECSCUSR cursor style, which shares the `q` final byte", () => {
    // CSI 2 SP q — not a query; only the private `CSI > q` form is.
    const cursorStyle = `${ESC}[2 q`
    expect(sanitizeReplay(`a${cursorStyle}b`)).toBe(`a${cursorStyle}b`)
  })

  test("keeps cursor show/hide", () => {
    expect(sanitizeReplay(`a${ESC}[?25lb`)).toBe(`a${ESC}[?25lb`)
    expect(sanitizeReplay(`a${ESC}[?25hb`)).toBe(`a${ESC}[?25hb`)
  })

  test("keeps OSC window titles", () => {
    const title = `${ESC}]0;my title${BEL}`
    expect(sanitizeReplay(`a${title}b`)).toBe(`a${title}b`)
  })

  test("keeps plain text and newlines untouched", () => {
    expect(sanitizeReplay("hello\r\nworld\n")).toBe("hello\r\nworld\n")
  })

  test("keeps multi-byte content intact", () => {
    const text = "日本語 ✓ ★ \u{1F600}"
    expect(sanitizeReplay(text)).toBe(text)
  })
})

describe("sanitizeReplay — edges", () => {
  test("returns the input unchanged when there is no ESC at all", () => {
    const plain = "just some output"
    expect(sanitizeReplay(plain)).toBe(plain)
  })

  test("handles empty input", () => {
    expect(sanitizeReplay("")).toBe("")
  })

  test("strips several occurrences across a long buffer", () => {
    const buffer = `a${ESC}[?1003h` + "x".repeat(5000) + `${ESC}[>0q` + "y".repeat(5000) + `${ESC}[c`
    const out = sanitizeReplay(buffer)
    expect(out).not.toContain(`${ESC}[?1003h`)
    expect(out).not.toContain(`${ESC}[>0q`)
    expect(out).toContain("x".repeat(5000))
    expect(out).toContain("y".repeat(5000))
  })

  test("is idempotent", () => {
    const buffer = `a${ESC}[?1003h${ESC}[>0qb`
    expect(sanitizeReplay(sanitizeReplay(buffer))).toBe(sanitizeReplay(buffer))
  })
})
