import { describe, expect, test } from "bun:test"
import { safeChunkEnd, safeStartIndex, safeTrimStart } from "./safe-slice"

const ESC = "\x1b"
const BEL = "\x07"
// U+1F600 GRINNING FACE — one codepoint, two UTF-16 code units.
const EMOJI = "\u{1F600}"

describe("safeStartIndex", () => {
  test("leaves a cut on plain text alone", () => {
    expect(safeStartIndex("hello world", 6)).toBe(6)
  })

  test("clamps out-of-range offsets", () => {
    expect(safeStartIndex("abc", -5)).toBe(0)
    expect(safeStartIndex("abc", 99)).toBe(3)
  })

  test("moves past a lone low surrogate so a pair is never split", () => {
    const text = `ab${EMOJI}cd`
    // index 3 is the LOW half of the surrogate pair.
    expect(safeStartIndex(text, 3)).toBe(4)
    expect(text.slice(safeStartIndex(text, 3))).toBe("cd")
  })

  test("a cut exactly on the high surrogate keeps the whole codepoint", () => {
    const text = `ab${EMOJI}cd`
    expect(safeStartIndex(text, 2)).toBe(2)
    expect(text.slice(2)).toBe(`${EMOJI}cd`)
  })

  test("a cut inside a CSI sequence resumes after its final byte", () => {
    const text = `xx${ESC}[1;31mred`
    const cut = text.indexOf("1;31") // mid-parameter
    expect(text.slice(safeStartIndex(text, cut))).toBe("red")
  })

  test("a cut immediately after ESC[ resumes after the sequence", () => {
    const text = `${ESC}[38;5;196mfoo`
    expect(text.slice(safeStartIndex(text, 2))).toBe("foo")
  })

  test("a cut after a CLOSED sequence is left alone", () => {
    const text = `${ESC}[0mplain text here`
    const cut = text.indexOf("text")
    expect(safeStartIndex(text, cut)).toBe(cut)
  })

  test("a cut inside an OSC sequence resumes after BEL", () => {
    const text = `${ESC}]0;my window title${BEL}after`
    const cut = text.indexOf("window")
    expect(text.slice(safeStartIndex(text, cut))).toBe("after")
  })

  test("a cut inside an OSC sequence resumes after an ST terminator", () => {
    const text = `${ESC}]7;file:///tmp/x${ESC}\\after`
    const cut = text.indexOf("tmp")
    expect(text.slice(safeStartIndex(text, cut))).toBe("after")
  })

  test("an unterminated escape running to the end drops the remainder", () => {
    const text = `${ESC}[1;2;3;4;5`
    // Nothing safe remains — better empty than a fragment xterm prints literally.
    expect(text.slice(safeStartIndex(text, 4))).toBe("")
  })

  test("an ESC far behind the cut is not treated as open", () => {
    const text = `${ESC}[0m` + "x".repeat(500) + "tail"
    const cut = text.length - 4
    expect(safeStartIndex(text, cut)).toBe(cut)
  })
})

describe("safeChunkEnd", () => {
  test("never ends a chunk between surrogate halves", () => {
    const text = `ab${EMOJI}cd`
    // index 3 would cut the pair; back off to 2.
    expect(safeChunkEnd(text, 3)).toBe(2)
  })

  test("leaves safe boundaries alone", () => {
    const text = `ab${EMOJI}cd`
    expect(safeChunkEnd(text, 2)).toBe(2)
    expect(safeChunkEnd(text, 4)).toBe(4)
  })

  test("clamps out-of-range offsets", () => {
    expect(safeChunkEnd("abc", -1)).toBe(0)
    expect(safeChunkEnd("abc", 10)).toBe(3)
  })

  test("re-chunking a string with emoji reassembles it exactly", () => {
    const text = `${EMOJI}${EMOJI}${EMOJI}${EMOJI}`
    const chunks: string[] = []
    let i = 0
    while (i < text.length) {
      const end = safeChunkEnd(text, Math.min(text.length, i + 3))
      chunks.push(text.slice(i, end))
      i = end
    }
    expect(chunks.join("")).toBe(text)
    // No chunk carries a lone surrogate.
    for (const chunk of chunks) {
      expect(chunk).toBe(Array.from(chunk).join(""))
    }
  })
})

describe("safeTrimStart", () => {
  test("returns the input when it already fits", () => {
    expect(safeTrimStart("abc", 10)).toBe("abc")
  })

  test("returns empty for a non-positive cap", () => {
    expect(safeTrimStart("abc", 0)).toBe("")
  })

  test("never returns more than the cap", () => {
    const text = "x".repeat(100)
    expect(safeTrimStart(text, 10).length).toBeLessThanOrEqual(10)
  })

  test("does not leave a partial escape at the head", () => {
    // Cap lands inside the colour sequence; the trimmed head must not start
    // mid-CSI or xterm prints the parameter bytes as literal text.
    const text = "old output" + `${ESC}[1;31m` + "new output"
    const trimmed = safeTrimStart(text, 14)
    expect(trimmed.startsWith(`${ESC}[`)).toBe(false)
    expect(trimmed).toBe("new output")
  })

  test("does not leave a lone surrogate at the head", () => {
    const text = "abcd" + EMOJI + "ef"
    const trimmed = safeTrimStart(text, 3)
    expect(trimmed).toBe(Array.from(trimmed).join(""))
  })
})
