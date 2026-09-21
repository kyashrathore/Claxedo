import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { spawn as spawnChild, type ChildProcess } from "node:child_process"
import { volatileLaunchOwnership } from "@claxedo/agent-sdk-runtime/launch"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { WSContext } from "hono/ws"
import { historyPath } from "./history-disk"
import { createProcessObserver, type ProcessObserverEvent } from "../managed-processes/process-observer"

type DataHandler = (data: string) => void
type ExitHandler = (event: { exitCode: number }) => void | Promise<void>

const fakeProcesses = new Map<number, {
  dataHandlers: DataHandler[]
  exitHandlers: ExitHandler[]
}>()
let nextSpawnPid: number | undefined
const nativeKills: number[] = []
const disposableChildren: ChildProcess[] = []

/**
 * The PTY library is faked, but the process it reports must be real: retirement
 * refuses to signal anything whose creation identity it cannot read, so a made
 * up pid would make every one of these removals unresolved for the wrong
 * reason. `detached` reproduces the session leadership `forkpty` gives a shell.
 */
function disposablePid() {
  const child = spawnChild("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
  disposableChildren.push(child)
  return child.pid!
}

/** EPERM means the process is there and belongs to someone else, not that it is gone. */
/** These tests assert PTY lifecycle, not recovery: the records die with the test. */
const ownership = volatileLaunchOwnership()

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

await mock.module("@lydell/node-pty", () => ({
  spawn(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> }) {
    const pid = nextSpawnPid ?? disposablePid()
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

const previousOrphanTimeout = process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS
const previousHistoryDir = process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-pty-"))
  process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS = "5"
  process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(tmpDir, "history")
  fakeProcesses.clear()
  nextSpawnPid = undefined
  nativeKills.length = 0
})

afterEach(async () => {
  const { Pty } = await import("./index")
  await Pty.dispose()
  for (const child of disposableChildren.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL") } catch {}
  }
  fakeProcesses.clear()
  if (previousOrphanTimeout === undefined) {
    delete process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS
  } else {
    process.env.CLAXEDO_PTY_ORPHAN_TIMEOUT_MS = previousOrphanTimeout
  }
  if (previousHistoryDir === undefined) {
    delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
  } else {
    process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previousHistoryDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("Pty lifecycle cleanup", () => {
  test("persists the opaque create request id in the authoritative PTY inventory", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({
      cwd: tmpDir,
      title: "correlated",
      createRequestId: "request-client-a",
    }, ownership)

    expect(info.createRequestId).toBe("request-client-a")
    expect(Pty.get(info.id)?.createRequestId).toBe("request-client-a")
    expect(Pty.list().find((row) => row.id === info.id)?.createRequestId).toBe("request-client-a")
  })

  test("an unavailable native pid does not block observation or native PTY cleanup", async () => {
    const { Pty } = await import("./index")
    const events: ProcessObserverEvent[] = []
    const observer = createProcessObserver({ sink: (event) => events.push(event) })
    nextSpawnPid = 0

    const info = await Pty.create(
      { cwd: tmpDir, title: "unknown-pid" },
      ownership,
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
    // Without a pid there is no creation identity, so nothing can be signalled
    // and nothing may be claimed: the native handle is closed and the terminal
    // is kept for a later attempt rather than reported stopped.
    await expect(observer.invoke({
      ownerId: registered.descriptor.ownerId,
      ownerGeneration: registered.descriptor.ownerGeneration,
      operation: "stop",
    })).resolves.toBe("unresolved")
    expect(nativeKills).toContain(0)
    expect(Pty.get(info.id)).toBeDefined()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.cleanup).toBe("unresolved")
    expect(Pty.activity().running).toBe(1)

    expect(Pty.abandon(info.id)?.error?.code).toBe("ownership_unverified")
    expect(Pty.get(info.id)).toBeUndefined()
  })

  test("remove closes subscribers, flushes history, kills the process group, and deletes the session", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "cleanup" }, ownership)
    const ws = socket()
    Pty.connect(info.id, ws)

    Pty.write(info.id, "printf hello\n")
    await waitFor(() => Pty.snapshot(info.id).includes("hello"))
    await Pty.remove(info.id)

    expect(ws.tracker.closeCount).toBeGreaterThan(0)
    expect(await fs.readFile(historyPath(info.cwd, info.id), "utf8")).toContain("hello")
    expect(Pty.get(info.id)).toBeUndefined()
    expect(alive(info.pid)).toBe(false)
  })

  test("orphan timeout removes abandoned unmanaged sessions", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "orphan" }, ownership)
    expect(Pty.activity()).toEqual({ running: 1, committed: 0, provisional: 1, managed: 0, subscribers: 0 })
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(true)

    await waitFor(() => Pty.get(info.id) === undefined)

    expect(Pty.get(info.id)).toBeUndefined()
    expect(alive(info.pid)).toBe(false)
  })

  test("committed sessions survive subscriber disconnects", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "committed" }, ownership)

    expect(Pty.commit(info.id)).toEqual(info)
    expect(Pty.listDetailed().find((session) => session.id === info.id)).toMatchObject({
      committed: true,
      orphanTimerActive: false,
    })
    const connection = Pty.connect(info.id, socket())
    connection?.onClose()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(Pty.get(info.id)).toEqual(info)
    expect(Pty.activity()).toEqual({ running: 1, committed: 1, provisional: 0, managed: 0, subscribers: 0 })
    expect(alive(info.pid)).toBe(true)
  })

  test("reconnect cancels the orphan timer", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "reconnect" }, ownership)
    const first = Pty.connect(info.id, socket())

    first?.onClose()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(true)

    Pty.connect(info.id, socket())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(Pty.get(info.id)).toBeDefined()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(false)
    expect(alive(info.pid)).toBe(true)
  })

  test("remove clears a pending orphan timer", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "remove-orphan" }, ownership)
    const connection = Pty.connect(info.id, socket())

    connection?.onClose()
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.orphanTimerActive).toBe(true)

    await Pty.remove(info.id)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(Pty.get(info.id)).toBeUndefined()
    expect(alive(info.pid)).toBe(false)
  })

  test("explicit remove wins a race with native exit retention", async () => {
    const { Pty } = await import("./index")
    const info = await Pty.create({ cwd: tmpDir, title: "exit-remove-race" }, ownership)
    const handlers = fakeProcesses.get(info.pid)?.exitHandlers ?? []

    const exiting = Promise.all(handlers.map((handler) => handler({ exitCode: 0 })))
    await Pty.remove(info.id)
    await exiting

    expect(Pty.get(info.id)).toBeUndefined()
  })

  test("dispose removes every active session", async () => {
    const { Pty } = await import("./index")
    const first = await Pty.create({ cwd: tmpDir, title: "first" }, ownership)
    const second = await Pty.create({ cwd: tmpDir, title: "second" }, ownership)

    await Pty.dispose()

    expect(Pty.list()).toEqual([])
    expect(alive(first.pid)).toBe(false)
    expect(alive(second.pid)).toBe(false)
  })
})

describe("Pty agent hook access", () => {
  const hookAccess = (token: string) => ({
    token,
    context: {
      actor: { actorId: "actor_1", actorKind: "human" as const },
      authority: { managed: true as const, workspaceId: "ws_1", orgId: "org_1", role: "editor" as const },
    },
    sessionId: "ses_1",
    authorityLease: "lease_1",
    authorityExpiresAt: Date.now() + 60_000,
  })

  test("lookup resolves the correct token and rejects incorrect and different-length tokens", async () => {
    const { Pty } = await import("./index")
    const token = "01234567-89ab-cdef-0123-456789abcdef"
    const info = await Pty.create({ cwd: tmpDir, title: "hook" }, ownership, undefined, hookAccess(token))

    expect(Pty.agentHookAccessForToken(token)).toMatchObject({ terminalId: info.id, sessionId: "ses_1" })
    expect(Pty.agentHookAccessForToken("01234567-89ab-cdef-0123-456789abcdee")).toBeUndefined()
    expect(Pty.agentHookAccessForToken("01234567-89ab-cdef-0123-456789abcdeff")).toBeUndefined()
    expect(Pty.agentHookAccessForToken("short")).toBeUndefined()
  })

  test("renewal updates the correct token's lease and rejects incorrect and different-length tokens", async () => {
    const { Pty } = await import("./index")
    const token = "01234567-89ab-cdef-0123-456789abcdef"
    const info = await Pty.create({ cwd: tmpDir, title: "hook-renew" }, ownership, undefined, hookAccess(token))

    expect(Pty.renewAgentHookAccess(token, { authorityLease: "lease_2", authorityExpiresAt: 42 })).toBe(true)
    expect(Pty.agentHookAccessForToken(token)).toMatchObject({
      terminalId: info.id,
      authorityLease: "lease_2",
      authorityExpiresAt: 42,
    })
    expect(Pty.renewAgentHookAccess("01234567-89ab-cdef-0123-456789abcdee", { authorityLease: "lease_3", authorityExpiresAt: 43 })).toBe(false)
    expect(Pty.renewAgentHookAccess("shorter", { authorityLease: "lease_3", authorityExpiresAt: 43 })).toBe(false)
    expect(Pty.agentHookAccessForToken(token)).toMatchObject({ authorityLease: "lease_2", authorityExpiresAt: 42 })
  })
})

/**
 * A `WSContext` double, with a plain counter for the one thing tests assert on.
 *
 * The counter exists so an assertion reads `ws.closed`, not `ws.close` — the
 * latter reads a method off the context and hands it to `expect`, which is
 * exactly the detached-method shape that goes wrong when the real `WSContext`
 * ever needs `this`.
 */
function socket() {
  const tracker = { closeCount: 0 }
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: mock(() => {}),
    close: mock(() => {
      tracker.closeCount += 1
    }),
  } as unknown as WSContext
  return Object.assign(ws, { tracker })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("Pty unresolved retirement", () => {
  test("a terminal that ignores TERM is escalated to KILL and only then reported stopped", async () => {
    const { Pty } = await import("./index")
    const stubborn = spawnChild("/bin/sh", ["-c", "trap '' TERM; while true; do sleep 0.05; done"], {
      detached: true,
      stdio: "ignore",
    })
    disposableChildren.push(stubborn)
    nextSpawnPid = stubborn.pid!
    // Let the trap take effect, or the first TERM kills it for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const info = await Pty.create({ cwd: tmpDir, title: "stubborn" }, ownership)
    expect(info.pid).toBe(stubborn.pid!)

    const result = await Pty.remove(info.id)

    expect(result?.leader).toBe("exited")
    expect(result?.signals.map((item) => item.signal)).toEqual(["SIGTERM", "SIGKILL"])
    expect(alive(stubborn.pid!)).toBe(false)
    expect(Pty.get(info.id)).toBeUndefined()
  }, 20_000)

  test("a pid the runtime did not spawn records no identity and never becomes a signal target", async () => {
    const { Pty } = await import("./index")
    // init: alive, readable, and emphatically not ours. Recording its identity
    // would make the next removal signal the whole machine's process group 1.
    nextSpawnPid = 1

    const info = await Pty.create({ cwd: tmpDir, title: "foreign" }, ownership)
    const result = await Pty.remove(info.id)

    expect(result?.error?.code).toBe("ownership_unverified")
    expect(result?.signals).toEqual([])
    expect(alive(1)).toBe(true)
    expect(Pty.listDetailed().find((session) => session.id === info.id)?.cleanup).toBe("unresolved")
    // A second remove retries rather than reporting a terminal already claimed stopped.
    expect((await Pty.remove(info.id))?.error?.code).toBe("ownership_unverified")
    Pty.abandon(info.id)
  }, 20_000)

  test("a store that cannot record ownership refuses the launch before anything is spawned", async () => {
    const { Pty } = await import("./index")
    const { LaunchRefusedError } = await import("@claxedo/agent-sdk-runtime/launch")
    const before = Pty.list().length
    const refusing = {
      ...volatileLaunchOwnership(),
      prepare: async () => { throw new Error("workspace store is unavailable") },
    }

    const failure = await Pty.create({ cwd: tmpDir, title: "refused" }, refusing).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(LaunchRefusedError)
    expect((failure as { code: string }).code).toBe("launch_refused_ownership_unavailable")
    expect(Pty.list().length).toBe(before)
  })
})
