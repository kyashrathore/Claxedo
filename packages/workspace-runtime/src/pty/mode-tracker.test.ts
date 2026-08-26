import { describe, expect, test } from "bun:test"
import { createModeTracker } from "./mode-tracker"

const ESC = "\x1b"

function tracker() {
  return createModeTracker(80, 24)
}

describe("createModeTracker", () => {
  test("a default terminal needs no preamble", () => {
    const t = tracker()
    expect(t.buildPreamble()).toBe("")
    t.dispose()
  })

  test("reflects modes synchronously — no waiting on xterm's write buffer", () => {
    const t = tracker()
    t.feed(`${ESC}[?2004h`)
    // Read IMMEDIATELY after feed: the attach path builds the preamble inline.
    expect(t.buildPreamble()).toContain(`${ESC}[?2004h`)
    t.dispose()
  })

  test("tracks bracketed paste on and off", () => {
    const t = tracker()
    t.feed(`${ESC}[?2004h`)
    expect(t.buildPreamble()).toContain("2004h")
    t.feed(`${ESC}[?2004l`)
    expect(t.buildPreamble()).toBe("")
    t.dispose()
  })

  test("tracks application cursor keys", () => {
    const t = tracker()
    t.feed(`${ESC}[?1h`)
    expect(t.buildPreamble()).toContain(`${ESC}[?1h`)
    t.dispose()
  })

  test("emits the ACTIVE mouse tracking level, not a set of flags", () => {
    const t = tracker()
    t.feed(`${ESC}[?1003h`)
    const preamble = t.buildPreamble()
    expect(preamble).toContain(`${ESC}[?1003h`)
    // Only one level — emitting several would leave the peer in the wrong mode.
    expect(preamble).not.toContain("?1000h")
    expect(preamble).not.toContain("?1002h")
    t.dispose()
  })

  test("a mouse level turned off leaves nothing behind — the leak that started all this", () => {
    const t = tracker()
    t.feed(`${ESC}[?1003h${ESC}[?1006h`)
    expect(t.buildPreamble()).toContain("1003h")
    t.feed(`${ESC}[?1003l`)
    expect(t.buildPreamble()).not.toContain("1003")
    t.dispose()
  })

  test("tracks focus reporting", () => {
    const t = tracker()
    t.feed(`${ESC}[?1004h`)
    expect(t.buildPreamble()).toContain(`${ESC}[?1004h`)
    t.dispose()
  })

  test("tracks the kitty keyboard protocol as effective flags", () => {
    const t = tracker()
    t.feed(`${ESC}[>7u`)
    expect(t.buildPreamble()).toMatch(/\x1b\[=\d+;1u/)
    t.dispose()
  })

  test("emits cursor-hidden only when the program hid it", () => {
    const t = tracker()
    expect(t.buildPreamble()).not.toContain("?25l")
    t.feed(`${ESC}[?25l`)
    expect(t.buildPreamble()).toContain(`${ESC}[?25l`)
    t.feed(`${ESC}[?25h`)
    expect(t.buildPreamble()).not.toContain("?25l")
    t.dispose()
  })

  test("never re-enters the alternate screen — the buffer restore owns that", () => {
    const t = tracker()
    t.feed(`${ESC}[?1049h`)
    const preamble = t.buildPreamble()
    expect(preamble).not.toContain("1049")
    expect(preamble).not.toContain("47h")
    t.dispose()
  })

  test("never re-asserts synchronized output, which would freeze rendering", () => {
    const t = tracker()
    t.feed(`${ESC}[?2026h`)
    expect(t.buildPreamble()).not.toContain("2026")
    t.dispose()
  })

  test("parses sequences split across feeds", () => {
    const t = tracker()
    t.feed(`${ESC}[?20`)
    t.feed("04h")
    expect(t.buildPreamble()).toContain("2004h")
    t.dispose()
  })

  test("survives malformed input without throwing", () => {
    const t = tracker()
    expect(() => t.feed(`${ESC}[?????zzz`)).not.toThrow()
    expect(() => t.feed("\x00\x01\x02")).not.toThrow()
    t.dispose()
  })

  test("ignores empty feeds", () => {
    const t = tracker()
    expect(() => t.feed("")).not.toThrow()
    expect(t.buildPreamble()).toBe("")
    t.dispose()
  })

  test("resize is idempotent and clamps nonsense geometry", () => {
    const t = tracker()
    expect(() => t.resize(120, 40)).not.toThrow()
    expect(() => t.resize(120, 40)).not.toThrow()
    expect(() => t.resize(0, 0)).not.toThrow()
    expect(() => t.resize(-5, -5)).not.toThrow()
    t.dispose()
  })

  test("combines several live modes into one preamble", () => {
    const t = tracker()
    t.feed(`${ESC}[?1h${ESC}[?2004h${ESC}[?1002h${ESC}[?1004h`)
    const preamble = t.buildPreamble()
    expect(preamble).toContain(`${ESC}[?1h`)
    expect(preamble).toContain(`${ESC}[?2004h`)
    expect(preamble).toContain(`${ESC}[?1002h`)
    expect(preamble).toContain(`${ESC}[?1004h`)
    t.dispose()
  })

  test("plain output does not invent cursor state and skips embedded OSC payloads", () => {
    const t = tracker()
    t.feed("plain output".repeat(10_000))
    t.feed(`${ESC}]0;literal ${ESC}[?1h in a title\x07`)
    expect(t.buildPreamble()).toBe("")
    t.feed(`${ESC}[?2004h`)
    expect(t.buildPreamble()).toBe(`${ESC}[?2004h`)
    t.dispose()
  })

  test("tracks the remaining reconnect-owned modes", () => {
    const t = tracker()
    t.feed(`${ESC}=${ESC}[4h${ESC}[?6;45h${ESC}[?7l`)
    expect(t.buildPreamble()).toBe(`${ESC}[?66h${ESC}[4h${ESC}[?6h${ESC}[?45h${ESC}[?7l`)
    t.feed(`${ESC}>${ESC}[4l${ESC}[?6;45l${ESC}[?7h`)
    expect(t.buildPreamble()).toBe("")
    t.dispose()
  })

  test("tracks kitty set, add, remove, push, and pop as effective flags", () => {
    const t = tracker()
    t.feed(`${ESC}[=3;1u`)
    expect(t.buildPreamble()).toContain(`${ESC}[=3;1u`)
    t.feed(`${ESC}[=4;2u`)
    expect(t.buildPreamble()).toContain(`${ESC}[=7;1u`)
    t.feed(`${ESC}[=2;3u`)
    expect(t.buildPreamble()).toContain(`${ESC}[=5;1u`)
    t.feed(`${ESC}[>1u`)
    expect(t.buildPreamble()).toContain(`${ESC}[=1;1u`)
    t.feed(`${ESC}[<1u`)
    expect(t.buildPreamble()).toContain(`${ESC}[=5;1u`)
    t.dispose()
  })


  test("reset and mouse disable semantics match the reconnect contract", () => {
    const t = tracker()
    t.feed(`${ESC}[?1003h${ESC}[?1000l`)
    expect(t.buildPreamble()).toBe("")

    t.feed(`${ESC}[?1003h${ESC}[?1h${ESC}=${ESC}[?2004h${ESC}[4h${ESC}[?6;45;1004h${ESC}[?25;7l${ESC}[=7;1u`)
    expect(t.buildPreamble()).not.toBe("")
    t.feed(`${ESC}[!p`)
    // DECSTR resets keyboard/input modes but, like xterm, preserves the
    // exclusive mouse level. It also clears the kitty stack/effective flags.
    expect(t.buildPreamble()).toBe(`${ESC}[?1003h`)

    t.feed(`${ESC}[?1002h${ESC}[?2004h${ESC}[=5;1u`)
    t.feed(`${ESC}c`)
    expect(t.buildPreamble()).toBe("")
    t.dispose()
  })

  test("dispose is safe to call twice", () => {
    const t = tracker()
    t.dispose()
    expect(() => t.dispose()).not.toThrow()
  })
})
