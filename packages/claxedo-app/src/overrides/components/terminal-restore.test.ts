import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { restoreBufferForSnapshot, restoreFitSettled } from "./terminal-restore"

function lines(t: Terminal) {
  const out: string[] = []
  for (let i = 0; i < t.buffer.active.length; i++) {
    out.push(t.buffer.active.getLine(i)?.translateToString(true) ?? "")
  }
  return out
}

function write(t: Terminal, data: string) {
  return new Promise<void>((resolve) => t.write(data, resolve))
}

describe("terminal restore buffer planning", () => {
  test("normal shell width remount preserves the saved prompt line", () => {
    const prompt = "~/test/opencode dev* > "
    const restore = restoreBufferForSnapshot({
      bufferToRestore: `$ ls\r\nfile.txt\r\n${prompt}`,
      isReload: false,
      wasAltScreen: false,
      snapshotWasAtBottom: true,
      splitWidthChanged: true,
      likelyTui: false,
    })

    expect(restore.buffer).toContain(prompt)
  })

  test("same-width right prompt snapshot restores on the same row", async () => {
    const source = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const serialize = new SerializeAddon()
    source.loadAddon(serialize)
    await write(source, "~/test/opencode dev* > \x1b[68G03:44:39 PM")

    const snapshot = serialize.serialize({ excludeAltBuffer: true, excludeModes: true })
    const restored = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    await write(restored, snapshot)

    expect(lines(restored)[0]).toContain("~/test/opencode dev* >")
    expect(lines(restored)[0]).toContain("03:44:39 PM")
    expect(lines(restored)[1]).not.toContain("03:44:39 PM")

    source.dispose()
    restored.dispose()
  })

  test("restore fit waits for saved cols before writing snapshot", () => {
    expect(
      restoreFitSettled({
        cols: 92,
        rows: 50,
        snapshotCols: 97,
        attempt: 1,
        maxAttempts: 8,
      }),
    ).toBe(false)
    expect(
      restoreFitSettled({
        cols: 97,
        rows: 50,
        snapshotCols: 97,
        attempt: 2,
        maxAttempts: 8,
      }),
    ).toBe(true)
  })

  test("restore fit eventually proceeds if saved cols never arrive", () => {
    expect(
      restoreFitSettled({
        cols: 92,
        rows: 50,
        snapshotCols: 97,
        attempt: 8,
        maxAttempts: 8,
      }),
    ).toBe(true)
  })
})
