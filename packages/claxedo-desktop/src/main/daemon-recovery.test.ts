import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readCreationIdentity, type CreationIdentity, type RetirementResult } from "@claxedo/agent-sdk-runtime/launch"

import {
  claxedoDaemonOwnershipPath,
  daemonRecoveryPreview,
  readDaemonOwnershipView,
  recoverPublishedDaemon,
} from "./daemon-recovery"
import {
  CLAXEDO_DAEMON_PROTOCOL,
  verifyClaxedoDaemonDiscovery,
  type ClaxedoDaemonDiscovery,
} from "./server-daemon-discovery"

const roots: string[] = []
const children: Array<() => void> = []

afterEach(() => {
  for (const kill of children.splice(0)) kill()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root() {
  const dir = mkdtempSync(join(tmpdir(), "claxedo-daemon-recovery-"))
  roots.push(dir)
  return dir
}

function identity(overrides: Partial<CreationIdentity> = {}): CreationIdentity {
  return {
    pid: 4242,
    processGroupId: 4242,
    parentPid: 1,
    startSecond: "Thu Jan  1 00:00:00 1970",
    startedAtMs: 0,
    bootTime: "0",
    source: "darwin-ps",
    ...overrides,
  }
}

function discovery(overrides: Partial<ClaxedoDaemonDiscovery> = {}): ClaxedoDaemonDiscovery {
  return {
    service: "claxedo-local-daemon",
    protocol: CLAXEDO_DAEMON_PROTOCOL,
    generation: "generation-1",
    token: "secret",
    pid: 4242,
    port: 2593,
    startedAt: "2026-09-21T00:00:00.000Z",
    identity: identity(),
    ...overrides,
  }
}

function operationOf(outcome: Awaited<ReturnType<typeof recoverPublishedDaemon>>) {
  if (outcome.outcome.kind !== "operation") throw new Error("expected an operation")
  return outcome.outcome.operation
}

/** A real disposable process this test owns, so identity is read rather than invented. */
async function disposableProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
  children.push(() => {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      // Already gone; the test's own assertions decide whether that is a failure.
    }
  })
  const creation = await readCreationIdentity(child.pid!)
  if (!creation) throw new Error("the disposable process reported no creation identity")
  return { child, creation }
}

describe("recovering a published daemon", () => {
  test("a record with no recorded identity is never signalled", async () => {
    let signalled = 0
    const result = await recoverPublishedDaemon({
      discovery: discovery({ identity: undefined }),
      authorize: () => true,
      verify: async () => {
        throw new Error("identity must not be probed when the record carries none")
      },
      retireLaunch: async () => {
        signalled += 1
        return { leader: "exited", descendants: "unknown", signals: [] }
      },
    })

    expect(signalled).toBe(0)
    expect(result.replacementAllowed).toBe(false)
    expect(operationOf(result).initiatingError?.code).toBe("ownership_unverified")
  })

  test("a reused pid is left alone and no replacement is started", async () => {
    let signalled = 0
    const result = await recoverPublishedDaemon({
      discovery: discovery(),
      authorize: () => true,
      verify: async () => ({ state: "identity_mismatch", observed: identity({ startSecond: "later" }) }),
      retireLaunch: async () => {
        signalled += 1
        return { leader: "exited", descendants: "unknown", signals: [] }
      },
    })

    expect(signalled).toBe(0)
    expect(result.replacementAllowed).toBe(false)
    expect(operationOf(result).initiatingError?.code).toBe("signal_denied")
  })

  test("launch does not authorize a kill: the daemon is left running and named", async () => {
    let signalled = 0
    const result = await recoverPublishedDaemon({
      discovery: discovery(),
      authorize: () => false,
      verify: async () => ({ state: "live", identity: identity() }),
      retireLaunch: async () => {
        signalled += 1
        return { leader: "exited", descendants: "unknown", signals: [] }
      },
    })

    expect(signalled).toBe(0)
    expect(result.replacementAllowed).toBe(false)
    const operation = operationOf(result)
    expect(operation.state).toBe("needs_action")
    expect(operation.facts.execution.value).toBe("running")
    expect(operation.nextActions.map((next) => next.action)).toEqual(["stop_daemon"])
    expect(operation.nextActions[0]?.scopePreviewRequired).toBe(true)
  })

  test("a process still alive after KILL keeps the machine unresolved", async () => {
    const survivor: RetirementResult = {
      leader: "alive",
      descendants: "owned",
      signals: [
        { signal: "SIGTERM", scope: "group", delivered: true },
        { signal: "SIGKILL", scope: "group", delivered: true },
      ],
      error: { code: "exit_unverified", message: "still alive after SIGKILL" },
    }
    const result = await recoverPublishedDaemon({
      discovery: discovery(),
      authorize: () => true,
      verify: async () => ({ state: "live", identity: identity() }),
      retireLaunch: async () => survivor,
    })

    expect(result.replacementAllowed).toBe(false)
    const operation = operationOf(result)
    expect(operation.state).toBe("needs_action")
    expect(operation.facts.execution.value).toBe("running")
    expect(operation.initiatingError?.code).toBe("exit_unverified")
  })

  test("an authorized stop of a real owned process is verified and allows a replacement", async () => {
    const { child, creation } = await disposableProcess()
    const result = await recoverPublishedDaemon({
      discovery: discovery({ pid: child.pid!, identity: creation }),
      authorize: () => true,
    })

    expect(operationOf(result).facts.execution.value).toBe("terminal")
    expect(result.replacementAllowed).toBe(true)
    expect(aliveNow(child.pid!)).toBe(false)
  })

  test("a live process the record does not answer for is left running", async () => {
    const { child, creation } = await disposableProcess()
    const result = await recoverPublishedDaemon({
      // The same pid with a creation second it cannot have: exactly a stale
      // discovery file whose pid has been reused.
      discovery: discovery({ pid: child.pid!, identity: { ...creation, startSecond: "Thu Jan  1 00:00:00 1970" } }),
      authorize: () => true,
    })

    expect(operationOf(result).initiatingError?.code).toBe("signal_denied")
    expect(result.replacementAllowed).toBe(false)
    expect(aliveNow(child.pid!)).toBe(true)
  })

  test("a daemon whose event loop is blocked is unreachable over HTTP and recoverable through the OS", async () => {
    // A real listener that answers once and then blocks its loop for a minute:
    // no timer inside it can fire, which is the whole reason the launcher owns
    // this path rather than asking the daemon to stop itself.
    const child = spawn(process.execPath, ["-e", `
      const http = require("node:http")
      const server = http.createServer(() => {
        process.send && process.send("blocking")
        const until = Date.now() + 60_000
        while (Date.now() < until) {}
      })
      server.listen(0, "127.0.0.1", () => process.send && process.send({ port: server.address().port }))
    `], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    children.push(() => {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // Already gone.
      }
    })
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the fake daemon never listened")), 10_000)
      child.on("message", (message: unknown) => {
        if (typeof message === "object" && message !== null && "port" in message) {
          clearTimeout(timer)
          resolve((message as { port: number }).port)
        }
      })
    })
    const creation = await readCreationIdentity(child.pid!)
    if (!creation) throw new Error("the fake daemon reported no creation identity")
    const record = discovery({ pid: child.pid!, port, identity: creation })

    // The probe's own deadline is what returns, not the blocked loop.
    expect(await verifyClaxedoDaemonDiscovery(record)).toBeUndefined()

    const asked: string[] = []
    const result = await recoverPublishedDaemon({
      discovery: record,
      authorize: (preview) => {
        asked.push(preview.summary)
        return true
      },
    })

    expect(asked).toHaveLength(1)
    expect(operationOf(result).facts.execution.value).toBe("terminal")
    expect(result.replacementAllowed).toBe(true)
    expect(aliveNow(child.pid!)).toBe(false)
  }, 30_000)

  test("a receipt from here is always volatile", async () => {
    const result = await recoverPublishedDaemon({
      discovery: discovery(),
      authorize: () => false,
      verify: async () => ({ state: "live", identity: identity() }),
    })

    expect(operationOf(result).receipt).toBe("volatile")
  })
})

describe("the ownership snapshot a launcher reads", () => {
  test("names the owners it recorded and how old the record is", () => {
    const dir = root()
    const file = claxedoDaemonOwnershipPath(dir)
    writeFileSync(file, JSON.stringify({
      machineId: "local",
      generation: "generation-1",
      pid: 4242,
      revision: "rev-1",
      writtenAt: 1_000,
      residencyPins: 2,
      owners: [
        { id: "workspace:ws_a", kind: "workspace_runtime", generation: "serving#0", state: "serving", pins: false },
        { id: "terminal:t1", kind: "terminal", generation: "77", state: "running", pins: true },
      ],
    }))

    const view = readDaemonOwnershipView(file)
    expect(view?.owners.map((owner) => owner.id)).toEqual(["workspace:ws_a", "terminal:t1"])
    const preview = daemonRecoveryPreview(discovery(), view, 31_000)
    expect(preview.resources).toEqual([
      "daemon generation generation-1 (pid 4242)",
      "workspace:ws_a (serving)",
      "terminal:t1 (running)",
    ])
    expect(preview.summary).toContain("stale")
    expect(preview.summary).toContain("additional impact is unknown")
  })

  test("a snapshot from another generation says nothing about this one", () => {
    const dir = root()
    const file = claxedoDaemonOwnershipPath(dir)
    writeFileSync(file, JSON.stringify({
      machineId: "local",
      generation: "generation-0",
      pid: 1,
      revision: "rev-0",
      writtenAt: 1_000,
      residencyPins: 0,
      owners: [{ id: "workspace:ws_old", kind: "workspace_runtime", generation: "serving#0", state: "serving", pins: false }],
    }))

    const preview = daemonRecoveryPreview(discovery(), readDaemonOwnershipView(file), 1_500)
    expect(preview.resources).toEqual(["daemon generation generation-1 (pid 4242)"])
    expect(preview.summary).toContain("unknown")
  })

  test("a missing snapshot is not an empty one", () => {
    expect(readDaemonOwnershipView(claxedoDaemonOwnershipPath(root()))).toBeUndefined()
  })
})

function aliveNow(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
