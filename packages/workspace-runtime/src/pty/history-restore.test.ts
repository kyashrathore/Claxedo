import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { WSContext } from "hono/ws"
import { historyPath } from "./history-disk"
import xterm from "@xterm/headless"
import { terminalCheckpointSchema, applyTerminalCheckpointState } from "./terminal-checkpoint-state"
import { volatileLaunchOwnership } from "@claxedo/agent-sdk-runtime/launch"

/** History restore is about transcripts, not recovery: these records die with the test. */
const ownership = volatileLaunchOwnership()

/**
 * End-to-end cover for the COLD RESTORE path: the PTY a client was attached to
 * is gone (server restart, sidecar death), the client asks for a replacement
 * naming the old one, and the replacement must come up carrying the old
 * session's scrollback.
 *
 * This is the path a user sees as "my terminal history survived the restart".
 * It spans three pieces that each have their own tests but had never been
 * exercised together: disk history append/flush, `renameHistory` re-keying the
 * file onto the new PTY id, and `create()` seeding the new session's buffer
 * plus arming the restored-session notice.
 */

type DataHandler = (data: string) => void
type ExitHandler = (event: { exitCode: number }) => void

const fakeProcesses = new Map<number, { dataHandlers: DataHandler[]; exitHandlers: ExitHandler[] }>()
let nextPid = 52000

await mock.module("@lydell/node-pty", () => ({
  spawn(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> }) {
    const pid = nextPid++
    fakeProcesses.set(pid, { dataHandlers: [], exitHandlers: [] })
    return {
      pid,
      write(data: string) {
        fakeProcesses.get(pid)?.dataHandlers.forEach((handler) => handler(data))
      },
      resize() {},
      onData(handler: DataHandler) {
        fakeProcesses.get(pid)?.dataHandlers.push(handler)
      },
      onExit(handler: ExitHandler) {
        fakeProcesses.get(pid)?.exitHandlers.push(handler)
      },
      command,
      args,
      options,
    }
  },
}))

const previousHistoryDir = process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
const previousOrphanTimeout = process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS

let tmpDir: string
let kill: ReturnType<typeof spyOn<typeof process, "kill">>

function socket() {
  const sent: Array<string | Uint8Array> = []
  return {
    ws: {
      readyState: 1,
      send: (data: unknown) => {
        if (typeof data === "string" || data instanceof Uint8Array) sent.push(data)
        else throw new Error("Unexpected PTY frame")
      },
      close: () => {},
    } as unknown as WSContext,
    sent,
    async text() {
      const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
      const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))
      try {
        for (const frame of sent) {
          if (typeof frame === "string") await write(frame)
          else {
            expect(frame[0]).toBe(0)
            const control = JSON.parse(new TextDecoder().decode(frame.subarray(1)))
            expect(Number.isSafeInteger(control.cursor)).toBe(true)
            if (control.checkpoint === undefined) continue
            const checkpoint = terminalCheckpointSchema.parse(control.checkpoint)
            terminal.reset()
            terminal.resize(checkpoint.cols, checkpoint.rows)
            await write(checkpoint.screen)
            await write(checkpoint.continuation)
            applyTerminalCheckpointState(terminal, checkpoint.state)
          }
        }
        return Array.from({ length: terminal.buffer.active.length }, (_, index) =>
          terminal.buffer.active.getLine(index)?.translateToString(true) ?? "").join("\n")
      } finally { terminal.dispose() }
    },
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pty-history-restore-"))
  process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(tmpDir, "history")
  process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS = "100000"
  fakeProcesses.clear()
  kill = spyOn(process, "kill").mockImplementation(() => true)
})

afterEach(async () => {
  const { Pty } = await import("./index")
  await Pty.dispose()
  kill.mockRestore()
  fakeProcesses.clear()
  if (previousHistoryDir === undefined) delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
  else process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previousHistoryDir
  if (previousOrphanTimeout === undefined) delete process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS
  else process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS = previousOrphanTimeout
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("cold restore: replacing a lost PTY", () => {
  test("the replacement session comes up carrying the old session's scrollback", async () => {
    const { Pty } = await import("./index")

    const first = await Pty.create({ cwd: tmpDir, title: "before" }, ownership)
    Pty.connect(first.id, socket().ws)
    Pty.write(first.id, "IMPORTANT-OUTPUT-FROM-BEFORE\n")
    await waitFor(() => Pty.snapshot(first.id).includes("IMPORTANT-OUTPUT-FROM-BEFORE"))
    // Flush the debounced disk writer the way a real shutdown does.
    await Pty.remove(first.id)

    const replacement = await Pty.create({
      cwd: tmpDir,
      title: "after",
      env: { previousPtyId: first.id },
    }, ownership)

    expect(Pty.snapshot(replacement.id)).toContain("IMPORTANT-OUTPUT-FROM-BEFORE")
  })

  test("a client attaching to the replacement is SENT the restored scrollback", async () => {
    const { Pty } = await import("./index")

    const first = await Pty.create({ cwd: tmpDir, title: "before" }, ownership)
    Pty.connect(first.id, socket().ws)
    Pty.write(first.id, "REPLAYED-TO-THE-CLIENT\n")
    await waitFor(() => Pty.snapshot(first.id).includes("REPLAYED-TO-THE-CLIENT"))
    await Pty.remove(first.id)

    const replacement = await Pty.create({
      cwd: tmpDir,
      title: "after",
      env: { previousPtyId: first.id },
    }, ownership)
    const client = socket()
    Pty.connect(replacement.id, client.ws)

    expect((await client.text())).toContain("REPLAYED-TO-THE-CLIENT")
  })

  test("the restored session is marked with the separator, exactly once", async () => {
    const { Pty } = await import("./index")

    const first = await Pty.create({ cwd: tmpDir, title: "before" }, ownership)
    Pty.connect(first.id, socket().ws)
    Pty.write(first.id, "OLD-CONTENT\n")
    await waitFor(() => Pty.snapshot(first.id).includes("OLD-CONTENT"))
    await Pty.remove(first.id)

    const replacement = await Pty.create({
      cwd: tmpDir,
      title: "after",
      env: { previousPtyId: first.id },
    }, ownership)

    const firstClient = socket()
    Pty.connect(replacement.id, firstClient.ws)
    expect((await firstClient.text())).toContain("Session contents restored")

    // The same stream checkpoint must not replay the seam a second time.
    const secondClient = socket()
    Pty.connect(replacement.id, secondClient.ws, Pty.snapshot(replacement.id).length)
    expect((await secondClient.text())).not.toContain("Session contents restored")
    const freshClient = socket()
    Pty.connect(replacement.id, freshClient.ws, 0)
    expect((await freshClient.text()).split("Session contents restored")).toHaveLength(2)
  })

  test("the separator sits between restored content and fresh shell output", async () => {
    const { Pty } = await import("./index")

    const first = await Pty.create({ cwd: tmpDir, title: "before" }, ownership)
    Pty.connect(first.id, socket().ws)
    Pty.write(first.id, "OLD-CONTENT\n")
    await waitFor(() => Pty.snapshot(first.id).includes("OLD-CONTENT"))
    await Pty.remove(first.id)

    const replacement = await Pty.create({
      cwd: tmpDir,
      title: "after",
      env: { previousPtyId: first.id },
    }, ownership)
    fakeProcesses.get(replacement.pid)!.dataHandlers.forEach((handler) => handler("NEW-PROMPT"))
    const client = socket()
    Pty.connect(replacement.id, client.ws)

    const text = (await client.text())
    expect(text.indexOf("OLD-CONTENT")).toBeLessThan(text.indexOf("Session contents restored"))
    expect(text.indexOf("Session contents restored")).toBeLessThan(text.indexOf("NEW-PROMPT"))
  })

  test("a session that replaced nothing is NOT marked as restored", async () => {
    const { Pty } = await import("./index")

    const fresh = await Pty.create({ cwd: tmpDir, title: "fresh" }, ownership)
    const client = socket()
    Pty.connect(fresh.id, client.ws)

    expect((await client.text())).not.toContain("Session contents restored")
  })

  test("the history file is re-keyed onto the new id, leaving none behind", async () => {
    const { Pty } = await import("./index")

    const first = await Pty.create({ cwd: tmpDir, title: "before" }, ownership)
    Pty.connect(first.id, socket().ws)
    Pty.write(first.id, "RE-KEYED\n")
    await waitFor(() => Pty.snapshot(first.id).includes("RE-KEYED"))
    await Pty.remove(first.id)

    const replacement = await Pty.create({
      cwd: tmpDir,
      title: "after",
      env: { previousPtyId: first.id },
    }, ownership)

    expect(await fs.readFile(historyPath(tmpDir, replacement.id), "utf8")).toContain("RE-KEYED")
    // The old path must not linger, or a later restore could resurrect it.
    await expect(fs.readFile(historyPath(tmpDir, first.id), "utf8")).rejects.toThrow()
  })

  test("naming a previous PTY that never existed degrades to a clean fresh session", async () => {
    const { Pty } = await import("./index")

    const replacement = await Pty.create({
      cwd: tmpDir,
      title: "after",
      env: { previousPtyId: "pty_does_not_exist" },
    }, ownership)
    const client = socket()
    Pty.connect(replacement.id, client.ws)

    expect(Pty.snapshot(replacement.id)).toBe("")
    // Nothing was restored, so there is no seam to mark.
    expect((await client.text())).not.toContain("Session contents restored")
  })

  test("restored content survives a SECOND loss — the chain does not break", async () => {
    const { Pty } = await import("./index")

    const first = await Pty.create({ cwd: tmpDir, title: "gen1" }, ownership)
    Pty.connect(first.id, socket().ws)
    Pty.write(first.id, "GENERATION-ONE\n")
    await waitFor(() => Pty.snapshot(first.id).includes("GENERATION-ONE"))
    await Pty.remove(first.id)

    const second = await Pty.create({ cwd: tmpDir, title: "gen2", env: { previousPtyId: first.id } }, ownership)
    Pty.connect(second.id, socket().ws)
    Pty.write(second.id, "GENERATION-TWO\n")
    await waitFor(() => Pty.snapshot(second.id).includes("GENERATION-TWO"))
    await Pty.remove(second.id)

    const third = await Pty.create({ cwd: tmpDir, title: "gen3", env: { previousPtyId: second.id } }, ownership)

    const snapshot = Pty.snapshot(third.id)
    expect(snapshot).toContain("GENERATION-ONE")
    expect(snapshot).toContain("GENERATION-TWO")
  })

  test("restored ANSI content is preserved byte-for-byte, not stripped", async () => {
    const { Pty } = await import("./index")

    // A TUI's scrollback is mostly escape sequences; a restore that mangles
    // them shows as coloured garbage rather than the frame the user left.
    const tuiish = "\x1b[1;32mBOLD-GREEN\x1b[0m \x1b[?25l\x1b[38;5;196mRED\x1b[0m\n"
    const first = await Pty.create({ cwd: tmpDir, title: "tui" }, ownership)
    Pty.connect(first.id, socket().ws)
    Pty.write(first.id, tuiish)
    await waitFor(() => Pty.snapshot(first.id).includes("BOLD-GREEN"))
    await Pty.remove(first.id)

    const replacement = await Pty.create({ cwd: tmpDir, title: "after", env: { previousPtyId: first.id } }, ownership)
    expect(Pty.snapshot(replacement.id)).toContain(tuiish.trimEnd())
  })
})
