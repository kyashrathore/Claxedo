import { afterEach, expect, test } from "bun:test"
import xterm from "@xterm/headless"
import { applyTerminalCheckpointState, captureTerminalCheckpointState } from "./terminal-checkpoint-state"

const terminals: InstanceType<typeof xterm.Terminal>[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })
function create() {
  const terminal = new xterm.Terminal({ cols: 20, rows: 5, scrollback: 100, allowProposedApi: true })
  terminals.push(terminal)
  return terminal
}
const write = (terminal: InstanceType<typeof xterm.Terminal>, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve))
const transported = (value: unknown) => JSON.parse(JSON.stringify(value))

test("invalid alternate-buffer state rejects before changing the normal buffer", async () => {
  const terminal = create()
  await write(terminal, "original")
  const before = captureTerminalCheckpointState(terminal)
  const invalid = transported(before)
  invalid.buffers.normal.x = 1
  invalid.buffers.alt.savedY = -1
  expect(() => applyTerminalCheckpointState(terminal, invalid)).toThrow()
  expect(captureTerminalCheckpointState(terminal)).toEqual(before)
})

test("out-of-viewport cursor and scroll region reject before mutation", async () => {
  const terminal = create()
  await write(terminal, "original")
  const before = captureTerminalCheckpointState(terminal)
  for (const invalidField of [{ x: 21 }, { y: 5 }, { scrollTop: 4, scrollBottom: 2 }, { scrollBottom: 5 }]) {
    const invalid = transported(before)
    Object.assign(invalid.buffers.normal, invalidField)
    expect(() => applyTerminalCheckpointState(terminal, invalid)).toThrow("restored geometry")
    expect(captureTerminalCheckpointState(terminal)).toEqual(before)
  }
})

test("a saved viewport cursor remains on the same row after history is omitted", async () => {
  const source = create()
  const target = create()
  await write(source, "history\r\n".repeat(40) + "\x1b[2;3H\x1b7\x1b[4;5H")
  await write(target, "history\r\n".repeat(8))
  applyTerminalCheckpointState(target, transported(captureTerminalCheckpointState(source)))
  await write(source, "\x1b8X")
  await write(target, "\x1b8X")
  expect(target.buffer.active.cursorX).toBe(source.buffer.active.cursorX)
  expect(target.buffer.active.cursorY).toBe(1)
  expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY)
  expect(target.buffer.active.getLine(target.buffer.active.baseY + 1)?.getCell(2)?.getChars()).toBe("X")
})

test("a split UTF-16 character continues through a transported checkpoint", async () => {
  const source = create()
  const target = create()
  await write(source, "abc\ud83e")
  await write(target, "abc")
  applyTerminalCheckpointState(target, transported(captureTerminalCheckpointState(source)))
  await write(source, "\uddd1X")
  await write(target, "\uddd1X")
  expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe("abc🧑X")
  expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe(source.buffer.active.getLine(0)?.translateToString(true))
  expect(target.buffer.active.cursorX).toBe(source.buffer.active.cursorX)
})
