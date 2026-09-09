import { afterEach, describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import { createTerminalRuntimeQueue } from "../terminal-runtime-queue"
import { buildRestoreWrite } from "../../ui/restore"

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

function harness() {
  const terminal = new Terminal({ cols: 80, rows: 5, scrollback: 100, allowProposedApi: true })
  const frames = new Map<number, () => void>()
  let nextFrame = 0
  const parses: Promise<void>[] = []
  const writes: string[] = []
  const queue = createTerminalRuntimeQueue({
    maxPendingBytes: 4096,
    maxStreamBytes: 4096,
    maxBatchBytes: 7,
    maxBatchItems: 2,
    maxDroppedChunks: 10,
    requestFrame: (run) => { const id = ++nextFrame; frames.set(id, run); return id },
    cancelFrame: (id) => { frames.delete(id) },
    write: (chunk, done) => {
      writes.push(chunk)
      parses.push(new Promise<void>((resolve) => terminal.write(chunk, () => { done(); resolve() })))
    },
    onOverload: () => { throw new Error("unexpected overload") },
  })
  cleanup.push(() => { queue.dispose(); terminal.dispose() })
  const drain = async () => {
    while (frames.size || parses.length) {
      const pending = [...frames.values()]
      frames.clear()
      for (const run of pending) run()
      await Promise.all(parses.splice(0))
    }
  }
  const text = () => Array.from({ length: terminal.buffer.active.length }, (_, row) =>
    terminal.buffer.active.getLine(row)?.translateToString(true) ?? "").filter(Boolean)
  return { terminal, queue, drain, text, writes }
}

describe("terminal runtime queue with the xterm parser", () => {
  test("pending output follows the real restore write, then live output continues in order", async () => {
    const h = harness()
    h.queue.push("pending 🙂\r\n")
    h.queue.push("pending two\r\n")
    expect(h.writes).toEqual([])
    await new Promise<void>((resolve) => h.terminal.write(buildRestoreWrite({
      modeSequences: "", restoreBuffer: "history\r\n", likelyTui: false,
    }), resolve))
    h.queue.flushPending()
    h.queue.push("live 🙃")
    await h.drain()
    expect(h.writes.join("")).toBe("pending 🙂\r\npending two\r\nlive 🙃")
    expect(h.text()).toEqual(["history", "pending 🙂", "pending two", "live 🙃"])
  })

  test("empty chunks never reach the parser or block subsequent pending and live output", async () => {
    const h = harness()
    h.queue.push("")
    expect(h.queue.pendingCount()).toBe(0)
    h.queue.push("before\r\n")
    h.queue.push("")
    h.queue.flushPending()
    h.queue.push("")
    h.queue.push("after")
    await h.drain()
    expect(h.writes.every((chunk) => chunk.length > 0)).toBe(true)
    expect(h.writes.join("")).toBe("before\r\nafter")
    expect(h.text()).toEqual(["before", "after"])
  })

  test("disposing one queue leaves another terminal's pending and live output intact", async () => {
    const first = harness()
    const second = harness()
    first.queue.flushPending()
    first.queue.push("discarded")
    second.queue.push("pending\r\n")
    first.queue.dispose()
    second.queue.flushPending()
    second.queue.push("live")
    await Promise.all([first.drain(), second.drain()])
    expect(first.writes).toEqual([])
    expect(first.text()).toEqual([])
    expect(second.text()).toEqual(["pending", "live"])
  })
})
