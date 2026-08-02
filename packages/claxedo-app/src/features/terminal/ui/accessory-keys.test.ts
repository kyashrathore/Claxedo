import { describe, expect, test } from "bun:test"
import { resolveAccessoryKey } from "./accessory-keys"

// These sequences are the contract the accessory row feeds into the terminal
// input path — a byte-for-byte match with what a physical keyboard emits is the
// whole point, so they are pinned exactly.

describe("resolveAccessoryKey — bare keys (Ctrl not armed)", () => {
  test("Esc sends the escape byte", () => {
    expect(resolveAccessoryKey("esc", false)).toEqual({ kind: "send", data: "\x1b" })
  })

  test("Tab sends a horizontal tab", () => {
    expect(resolveAccessoryKey("tab", false)).toEqual({ kind: "send", data: "\t" })
  })

  test("arrows send their bare cursor sequences", () => {
    expect(resolveAccessoryKey("up", false)).toEqual({ kind: "send", data: "\x1b[A" })
    expect(resolveAccessoryKey("down", false)).toEqual({ kind: "send", data: "\x1b[B" })
    expect(resolveAccessoryKey("right", false)).toEqual({ kind: "send", data: "\x1b[C" })
    expect(resolveAccessoryKey("left", false)).toEqual({ kind: "send", data: "\x1b[D" })
  })
})

describe("resolveAccessoryKey — sticky Ctrl modifier", () => {
  test("pressing Ctrl while disarmed arms it and emits nothing", () => {
    expect(resolveAccessoryKey("ctrl", false)).toEqual({ kind: "arm", ctrlArmed: true })
  })

  test("pressing Ctrl while armed disarms it and emits nothing", () => {
    expect(resolveAccessoryKey("ctrl", true)).toEqual({ kind: "arm", ctrlArmed: false })
  })

  test("an arrow with Ctrl armed uses the CSI 1;5 (Ctrl) modifier form", () => {
    expect(resolveAccessoryKey("up", true)).toEqual({ kind: "send", data: "\x1b[1;5A" })
    expect(resolveAccessoryKey("down", true)).toEqual({ kind: "send", data: "\x1b[1;5B" })
    expect(resolveAccessoryKey("right", true)).toEqual({ kind: "send", data: "\x1b[1;5C" })
    expect(resolveAccessoryKey("left", true)).toEqual({ kind: "send", data: "\x1b[1;5D" })
  })

  test("Esc/Tab with Ctrl armed still send their bare sequences (modifier applies to arrows)", () => {
    expect(resolveAccessoryKey("esc", true)).toEqual({ kind: "send", data: "\x1b" })
    expect(resolveAccessoryKey("tab", true)).toEqual({ kind: "send", data: "\t" })
  })
})
