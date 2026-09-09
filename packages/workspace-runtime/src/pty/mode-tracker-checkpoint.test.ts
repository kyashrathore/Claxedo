import { expect, test } from "bun:test"
import xterm from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { createModeTracker } from "./mode-tracker"
import { applyTerminalCheckpointState, terminalCheckpointSchema } from "./terminal-checkpoint-state"

function create() {
  const terminal = new xterm.Terminal({ cols: 20, rows: 5, scrollback: 5000, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = "11"
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  return { terminal, serializer }
}
const write = (terminal: InstanceType<typeof xterm.Terminal>, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve))

for (const [name, prefix, suffix] of [
  ["Unicode reflow", "12345678901234567🧑X", "Y"],
  ["alternate buffer and saved cursor", "normal\x1b[?1049h\x1b[HAB\x1b7CD", "\x1b8X\x1b[?1049lY"],
  ["executed newline in partial CSI", "abc\x1b[3\n", "1mX"],
  ["split Unicode in OSC", "abc\x1b]0;\ud83e", "\uddd1\x07X"],
  ["retained history beyond 1000 rows", "row\r\n".repeat(1500), "tail"],
] as const) {
  test(`host checkpoint preserves ${name} and subsequent output`, async () => {
    const host = createModeTracker(20, 5)
    const source = create()
    const target = create()
    try {
      for (const chunk of prefix.length > 1000 ? [prefix] : prefix.split("")) {
        host.feed(chunk)
        await write(source.terminal, chunk)
      }
      if (name === "Unicode reflow") {
        host.resize(25, 7)
        source.terminal.resize(25, 7)
      }
      const checkpoint = terminalCheckpointSchema.parse(JSON.parse(JSON.stringify(host.checkpoint())))
      target.terminal.resize(checkpoint.cols, checkpoint.rows)
      await write(target.terminal, checkpoint.screen)
      await write(target.terminal, checkpoint.continuation)
      applyTerminalCheckpointState(target.terminal, checkpoint.state)
      host.feed(suffix)
      await write(source.terminal, suffix)
      await write(target.terminal, suffix)
      expect(target.serializer.serialize()).toBe(source.serializer.serialize())
      expect(host.checkpoint().screen).toBe(source.serializer.serialize())
      expect(target.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX)
      expect(target.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY)
    } finally {
      host.dispose()
      source.terminal.dispose()
      target.terminal.dispose()
    }
  })
}
