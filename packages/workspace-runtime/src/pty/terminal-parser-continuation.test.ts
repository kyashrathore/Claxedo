import { afterEach, expect, test } from "bun:test"
import xterm from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { createTerminalParserContinuation } from "./terminal-parser-continuation"
import { applyTerminalCheckpointState, captureTerminalCheckpointState } from "./terminal-checkpoint-state"

const terminals: InstanceType<typeof xterm.Terminal>[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })
function create() {
  const terminal = new xterm.Terminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  terminals.push(terminal)
  return { terminal, serializer }
}
const write = (terminal: InstanceType<typeof xterm.Terminal>, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve))

const cases = [
  ["CSI", "abc\x1b[3", "1mX"],
  ["DCS", "abc\x1bP1$q", "payload\x1b\\X"],
  ["executed newline", "abc\x1b[3\n", "1mX"],
  ["cancellation", "abc\x1b[3\x18\x1b[3", "1mX"],
  ["OSC then escape", "abc\x1b]0;title\x1b", "[31mX"],
  ["C1", "abc\x9b3", "1mX"],
  ["split Unicode", "abc\ud83e", "\uddd1X"],
  ["Unicode in OSC", "abc\x1b]0;\ud83e", "\uddd1\x07X"],
] as const

for (const [name, prefix, suffix] of cases) {
  test(`incremental ${name} checkpoint matches uninterrupted xterm`, async () => {
    const source = create()
    const target = create()
    const continuation = createTerminalParserContinuation(source.terminal)
    // Deliberately split UTF-16 pairs as well as VT introducers/parameters.
    for (let index = 0; index < prefix.length; index++) {
      const chunk = prefix[index]
      await write(source.terminal, chunk)
      continuation.observe(chunk)
    }
    const metadata = JSON.parse(JSON.stringify(captureTerminalCheckpointState(source.terminal)))
    await write(target.terminal, source.serializer.serialize())
    await write(target.terminal, continuation.read())
    // Apply decoder carry AFTER replaying the control prefix, otherwise it
    // would consume that prefix as the second half of a surrogate pair.
    applyTerminalCheckpointState(target.terminal, metadata)
    await write(source.terminal, suffix)
    continuation.observe(suffix)
    await write(target.terminal, suffix)
    expect(target.serializer.serialize()).toBe(source.serializer.serialize())
    expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX)
    expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY)
    expect(continuation.read()).toBe("")
  })
}

test("oversize pending state rejects checkpoints and recovers at native ground", async () => {
  const source = create()
  const continuation = createTerminalParserContinuation(source.terminal)
  const start = "\x1b]0;"
  await write(source.terminal, start)
  continuation.observe(start)
  const chunk = "x".repeat(65_536)
  for (let index = 0; index < 17; index++) {
    await write(source.terminal, chunk)
    continuation.observe(chunk)
  }
  expect(() => continuation.read()).toThrow("exceeds checkpoint limit")
  await write(source.terminal, "\x07done")
  continuation.observe("\x07done")
  expect(continuation.read()).toBe("")
  expect(source.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("done")
})
