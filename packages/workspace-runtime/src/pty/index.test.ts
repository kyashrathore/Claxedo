import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { WSContext } from "hono/ws"
import { historyPath } from "./history-disk"
import { createProcessObserver, type ProcessObserverEvent } from "../managed-processes/process-observer"

type DataHandler = (data: string) => void
type ExitHandler = (event: { exitCode: number }) => void

const fakeProcesses = new Map<number, {
  dataHandlers: DataHandler[]
  exitHandlers: ExitHandler[]
}>()
let nextPid = 41000
let nextSpawnPid: number | undefined
const nativeKills: number[] = []

mock.module("@lydell/node-pty", () => ({
  spawn(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> }) {
    const pid = nextSpawnPid ?? nextPid++
    nextSpawnPid = undefined
    fakeProcesses.set(pid, { dataHandlers: [], exitHandlers: [] })
    return {
      pid,
      kill() {
        nativeKills.push(pid)
      },
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

const previousOrphanTimeout = process.env.OPENCODE_PTY_ORPHAN_TIMEOUT_MS
const previousHistoryDir = process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR

let tmpDir: string
let kill: ReturnType<typeof spyOn<typeof process, "kill">>

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-pty-"))
  process.env.OPENCODE_PTY_ORPHAN_TIMEOUT_MS = "5"
  process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(tmpDir, "history")
  fakeProcesses.clear()
  nextSpawnPid = undefined
  nativeKills.length = 0
  kill = spyOn(process, "kill").mockImplementation(() => true)
})

afterEach(async () => {
  const { Pty } = await import("./index")
  await Pty.dispose()
  kill.mockRestore()
  fakeProcesses.clear()
  if (previousOrphanTimeout === undefined) {
    delete process.env.OPENCODE_PTY_ORPHAN_TIMEOUT_MS
  } else {
    process.env.OPENCODE_PTY_ORPHAN_TIMEOUT_MS = previousOrphanTimeout
  }
  if (previousHistoryDir === undefined) {
    delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
  } else {
    process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previousHistoryDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("Pty lifecycle cleanup", () => {
  test("an unavailable native pid does not block observation or native PTY cleanup", async () => {
    const { Pty } = await import("./index")
    const events: ProcessObserverEvent[] = []
    const observer = createProcessObserver({ sink: (event) => events.push(event) })
    nextSpawnPid = 0

    const info = await Pty.create(
      { cwd: tmpDir, title: "unknown-pid" },
      {
        observer,
        kind: "pty",
        ownerId: "pty:unknown-pid",
        workspaceId: "ws_unknown_pid",
        directory: tmpDir,
        label: "Unknown PID",
      },
    )

    expect(info.pid).toBe(0)
    expect(events[0]).toMatchObject({
      type: "registered",
      descriptor: { ownerId: "pty:unknown-pid" },
      capabilities: { stopGracefully: true, killOwnedTree: false },
    })
    expect(events[0]).not.toHaveProperty("descriptor.pid")

    const registered = events[0] as Extract<ProcessObserverEvent, { type: "registered" }>
    await expect(observer.invoke({
      ownerId: registered.descriptor.ownerId,
      ownerGeneration: registered.descriptor.ownerGeneration,
      operation: "stop",
    })).resolves.toBe("completed")
    expect(nativeKills).toContain(0)
    expect(Pty.get(info.id)).toBeUndefined()
  })

  test("remove closes subscribers, flushes history, kills the process group, and deletes the session", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "cleanup" })
    const ws = socket()
    Pty.connect(info.id, ws)

    Pty.write(info.id, "printf hello\n")
    await waitFor(() => Pty.snapshot(info.id).includes("hello"))
    await Pty.remove(info.id)

    expect(ws.close).toHaveBeenCalled()
    expect(await fs.readFile(historyPath(info.cwd, info.id), "utf8")).toContain("hello")
    expect(Pty.get(info.id)).toBeUndefined()
    if (process.platform !== "win32") {
      expect(kill.mock.calls).toContainEqual([-info.pid, "SIGTERM"])
      expect(kill.mock.calls).toContainEqual([-info.pid, "SIGKILL"])
    }
    expect(kill.mock.calls).toContainEqual([info.pid, "SIGTERM"])
    expect(kill.mock.calls).toContainEqual([info.pid, "SIGKILL"])
  })

  test("orphan timeout removes abandoned unmanaged sessions", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "orphan" })
    const ws = socket()
    const connection = Pty.connect(info.id, ws)

    connection?.onClose()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(true)

    await waitFor(() => Pty.get(info.id) === undefined)

    expect(Pty.get(info.id)).toBeUndefined()
    expect(kill.mock.calls).toContainEqual([info.pid, "SIGTERM"])
  })

  test("reconnect cancels the orphan timer", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "reconnect" })
    const first = Pty.connect(info.id, socket())

    first?.onClose()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(true)

    Pty.connect(info.id, socket())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(Pty.get(info.id)).toBeDefined()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(false)
    expect(kill.mock.calls).toEqual([])
  })

  test("remove clears a pending orphan timer", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "remove-orphan" })
    const connection = Pty.connect(info.id, socket())

    connection?.onClose()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(true)

    await Pty.remove(info.id)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(Pty.get(info.id)).toBeUndefined()
    expect(kill.mock.calls.filter((call) => call[0] === info.pid)).toHaveLength(2)
  })

  test("dispose removes every active session", async () => {
    const { Pty } = await import("./index")
    const first = await Pty.create({ cwd: tmpDir, title: "first" })
    const second = await Pty.create({ cwd: tmpDir, title: "second" })

    await Pty.dispose()

    expect(Pty.list()).toEqual([])
    expect(kill.mock.calls).toContainEqual([first.pid, "SIGTERM"])
    expect(kill.mock.calls).toContainEqual([second.pid, "SIGTERM"])
  })
})

function socket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: mock(() => {}),
    close: mock(() => {}),
  } as unknown as WSContext
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
