import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { installInputModeReclaimer } from "../backend/input-mode-reclaimer"
import { SHELL_READY_MARKER_PAYLOAD } from "../leaked-input-mode-reclaim"

/**
 * Drives the reclaimer through a REAL xterm parser, so the escape-sequence
 * shapes and the OSC payload matching are exercised for real rather than
 * against a hand-rolled stub.
 */
const ESC = "\x1b"
const BEL = "\x07"
const PROMPT = `${ESC}]777;${SHELL_READY_MARKER_PAYLOAD}${BEL}`

function harness() {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const written: string[] = []
  const realWrite = terminal.write.bind(terminal)
  // Capture what the reclaimer writes back, and still feed it to the parser.
  terminal.write = ((data: string | Uint8Array, cb?: () => void) => {
    if (typeof data === "string") written.push(data)
    return realWrite(data as string, cb)
  }) as typeof terminal.write

  const reclaimer = installInputModeReclaimer(terminal as never)
  const feed = (data: string) =>
    new Promise<void>((resolve) => {
      realWrite(data, () => resolve())
    })
  const settle = () => new Promise<void>((r) => setTimeout(r, 0))

  return {
    terminal,
    feed,
    settle,
    /** Only what the reclaimer wrote back (feeds go through realWrite). */
    disarmWrites: () => written.join(""),
    dispose: () => reclaimer.dispose(),
  }
}

describe("installInputModeReclaimer (real xterm parser)", () => {
  test("disarms mouse tracking a killed TUI left armed", async () => {
    const h = harness()
    await h.feed(PROMPT)
    await h.feed(`${ESC}[?1003h${ESC}[?1006h`) // TUI arms any-event + SGR mouse
    await h.feed(PROMPT) // TUI died; shell prompt back
    await h.settle()
    expect(h.disarmWrites()).toContain(`${ESC}[?1003l`)
    h.dispose()
  })

  test("does not disarm when the TUI restored the mode itself", async () => {
    const h = harness()
    await h.feed(PROMPT)
    await h.feed(`${ESC}[?1003h`)
    await h.feed(`${ESC}[?1003l`) // clean exit
    await h.feed(PROMPT)
    await h.settle()
    expect(h.disarmWrites()).toBe("")
    h.dispose()
  })

  test("leaves a mode armed before the first prompt alone (shell-owned)", async () => {
    const h = harness()
    await h.feed(`${ESC}[?1003h`) // armed by shell init / a live tmux
    await h.feed(PROMPT)
    await h.settle()
    expect(h.disarmWrites()).toBe("")
    h.dispose()
  })

  test("disarms leaked kitty keyboard so Ctrl+C works again", async () => {
    const h = harness()
    await h.feed(PROMPT)
    await h.feed(`${ESC}[>7u`) // TUI pushes kitty flags
    await h.feed(PROMPT)
    await h.settle()
    const out = h.disarmWrites()
    expect(out).toContain(`${ESC}[<255u`)
    expect(out).toContain(`${ESC}[=0;1u`)
    h.dispose()
  })

  test("treats CSI = 0 ; 1 u as a disarm, not an arm", async () => {
    const h = harness()
    await h.feed(PROMPT)
    await h.feed(`${ESC}[>7u`)
    await h.feed(`${ESC}[=0;1u`) // TUI sets flags to 0 on exit
    await h.feed(PROMPT)
    await h.settle()
    expect(h.disarmWrites()).toBe("")
    h.dispose()
  })

  test("disarms leaked focus reporting", async () => {
    const h = harness()
    await h.feed(PROMPT)
    await h.feed(`${ESC}[?1004h`)
    await h.feed(PROMPT)
    await h.settle()
    expect(h.disarmWrites()).toContain(`${ESC}[?1004l`)
    h.dispose()
  })

  test("ignores OSC 777 payloads that are not our marker", async () => {
    const h = harness()
    await h.feed(PROMPT)
    await h.feed(`${ESC}[?1003h`)
    await h.feed(`${ESC}]777;some-other-tool${BEL}`) // not a prompt
    await h.settle()
    expect(h.disarmWrites()).toBe("")
    h.dispose()
  })

  test("a mode split across two writes is still tracked", async () => {
    const h = harness()
    await h.feed(PROMPT)
    // xterm reassembles the sequence across writes; the handler fires once.
    await h.feed(`${ESC}[?10`)
    await h.feed(`03h`)
    await h.feed(PROMPT)
    await h.settle()
    expect(h.disarmWrites()).toContain(`${ESC}[?1003l`)
    h.dispose()
  })

  test("writes nothing at a prompt when no TUI ever ran", async () => {
    const h = harness()
    await h.feed(PROMPT)
    await h.feed("some normal output\r\n")
    await h.feed(PROMPT)
    await h.settle()
    expect(h.disarmWrites()).toBe("")
    h.dispose()
  })

  test("dispose stops further reclaiming", async () => {
    const h = harness()
    await h.feed(PROMPT)
    h.dispose()
    await h.feed(`${ESC}[?1003h`)
    await h.feed(PROMPT)
    await h.settle()
    expect(h.disarmWrites()).toBe("")
  })
})
