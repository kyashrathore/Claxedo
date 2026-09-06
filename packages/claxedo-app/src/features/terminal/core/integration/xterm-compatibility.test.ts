import { afterEach, describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"

// Dependency compatibility checks for the public parser/serializer contract
// consumed by the renderer. Application restore ordering is covered separately.
const terminals: Terminal[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })

function makeTerminal(cols = 80, rows = 5) {
  const terminal = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
  terminals.push(terminal)
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  return { terminal, serializer }
}
const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))
const lines = (terminal: Terminal) => Array.from({ length: terminal.buffer.active.length }, (_, row) =>
  terminal.buffer.active.getLine(row)?.translateToString(true) ?? "")

describe("xterm parser and serializer compatibility", () => {
  test("serialization retains styled text and cursor position", async () => {
    const source = makeTerminal()
    await write(source.terminal, "\x1b[32mgreen\x1b[0m \x1b[1;31mred\x1b[0m\r\n$ ")
    const target = makeTerminal()
    await write(target.terminal, source.serializer.serialize({ excludeAltBuffer: true, excludeModes: true }))

    expect(lines(target.terminal).slice(0, 2)).toEqual(["green red", "$ "])
    // trimRight removes untouched cells; the explicitly written prompt space survives.
    expect(target.terminal.buffer.active.getLine(1)?.getCell(1)?.getChars()).toBe(" ")
    expect(target.terminal.buffer.active.cursorX).toBe(2)
    expect(target.terminal.buffer.active.cursorY).toBe(1)
    const line = target.terminal.buffer.active.getLine(0)!
    expect(line.getCell(0)?.getFgColor()).toBe(2)
    expect(line.getCell(6)?.getFgColor()).toBe(1)
    expect(line.getCell(6)?.isBold()).toBeTruthy()
  })

  test("serialization retains scrollback beyond the viewport", async () => {
    const source = makeTerminal()
    const transcript = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    await write(source.terminal, transcript.join("\r\n"))
    const target = makeTerminal()
    await write(target.terminal, source.serializer.serialize({ excludeAltBuffer: true, excludeModes: true }))
    expect(lines(target.terminal)).toEqual(transcript)
  })

  test("restoring at a narrower width retains logical text", async () => {
    const source = makeTerminal(40)
    await write(source.terminal, "01234567890123456789012345")
    const target = makeTerminal(10)
    await write(target.terminal, source.serializer.serialize({ excludeAltBuffer: true, excludeModes: true }))
    expect(lines(target.terminal).filter(Boolean)).toEqual(["0123456789", "0123456789", "012345"])
  })

  test("nonempty write callbacks finish in order across an intervening resize", async () => {
    const { terminal } = makeTerminal()
    const callbacks: number[] = []
    const writes = ["one\r\n", "two"].map((data, index) => new Promise<void>((resolve) => {
      terminal.write(data, () => { callbacks.push(index); resolve() })
    }))
    terminal.resize(40, 5)
    await Promise.all(writes)
    expect(callbacks).toEqual([0, 1])
    expect(lines(terminal).slice(0, 2)).toEqual(["one", "two"])
  })
})
