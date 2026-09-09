import { afterEach, describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { buildRestoreWrite } from "../../ui/restore"
import { createModeScanner } from "../mode-scan"
import { preparePersistBuffer, prepareRestoreBuffer } from "../terminal-buffer"

const terminals: Terminal[] = []
function terminal() {
  const value = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true })
  terminals.push(value)
  return value
}
const write = (target: Terminal, data: string) => new Promise<void>((resolve) => target.write(data, resolve))
const lines = (target: Terminal) => Array.from({ length: target.buffer.active.length }, (_, index) =>
  target.buffer.active.getLine(index)?.translateToString(true) ?? "").join("\n")

afterEach(() => { for (const value of terminals.splice(0)) value.dispose() })

describe("canonical restore bytes through the xterm parser", () => {
  test("restores a normal screen with input modes and accepts subsequent output", async () => {
    const target = terminal()
    await write(target, buildRestoreWrite({
      modeSequences: "\x1b[?2004h\x1b[?1h",
      restoreBuffer: "shell$ command\r\nresult\r\nshell$ ",
      likelyTui: false,
    }))
    expect(target.buffer.active.type).toBe("normal")
    expect(target.modes.bracketedPasteMode).toBe(true)
    expect(target.modes.applicationCursorKeysMode).toBe(true)
    expect(lines(target)).toContain("shell$ command\nresult\nshell$ ".trimEnd())
    await write(target, "next\r\nnext-result")
    expect(lines(target)).toContain("shell$ next\nnext-result")
  })

  test("restores the last TUI frame into the alternate screen before live output resumes", async () => {
    const target = terminal()
    await write(target, "normal-shell-history\r\n")
    await write(target, buildRestoreWrite({
      modeSequences: "\x1b[?2004h\x1b[?1h",
      restoreBuffer: "\x1b[?1049h\x1b[H\x1b[2JLast TUI frame\x1b[24;1HStatus bar",
      likelyTui: true,
    }))
    expect(target.buffer.active.type).toBe("alternate")
    expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe("Last TUI frame")
    expect(target.buffer.active.getLine(23)?.translateToString(true)).toBe("Status bar")
    expect(target.modes.bracketedPasteMode).toBe(true)
    await write(target, "\x1b[HLive TUI frame")
    expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe("Live TUI frame")
    await write(target, "\x1b[?1049l")
    expect(lines(target)).toContain("normal-shell-history")
    expect(lines(target)).not.toContain("TUI frame")
  })

  test("consumes real serialized alternate content without erasing its restored frame", async () => {
    const source = terminal()
    const serialize = new SerializeAddon()
    source.loadAddon(serialize)
    const mode = createModeScanner()
    const data = "\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[HTUI snapshot\x1b[24;1HFooter"
    mode.scan(data)
    await write(source, data)
    const target = terminal()
    await write(target, buildRestoreWrite({
      modeSequences: mode.rehydrateSequences(),
      restoreBuffer: serialize.serialize({ excludeAltBuffer: false, excludeModes: true }),
      likelyTui: true,
    }))
    expect(target.buffer.active.type).toBe("alternate")
    expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe("TUI snapshot")
    expect(target.buffer.active.getLine(23)?.translateToString(true)).toBe("Footer")
    expect(target.modes.bracketedPasteMode).toBe(true)
  })

  test("leaving a restored TUI returns to the original shell history and cursor", async () => {
    const source = terminal()
    const serializer = new SerializeAddon()
    source.loadAddon(serializer)
    await write(source, "shell-history-before-tui\r\nshell$ ")
    await write(source, "\x1b[?1049h\x1b[H\x1b[2JTUI frame\x1b[24;1HFooter")
    const buffer = prepareRestoreBuffer(preparePersistBuffer(serializer.serialize({ excludeModes: true })))
    const target = terminal()
    await write(target, buildRestoreWrite({
      modeSequences: "",
      restoreBuffer: buffer.value!,
      likelyTui: true,
    }))
    expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe("TUI frame")
    await write(source, "\x1b[?1049lreturned")
    await write(target, "\x1b[?1049lreturned")
    expect(lines(target)).toEqual(lines(source))
    expect(target.buffer.active.cursorX).toBe(source.buffer.active.cursorX)
    expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY)
  })
})
