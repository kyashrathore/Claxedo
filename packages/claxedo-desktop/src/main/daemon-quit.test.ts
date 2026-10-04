import { describe, expect, test } from "bun:test"
import type { RecoveryOutcome } from "@claxedo/agent-runtime-contract"

import { quitConfirmMessage, quitWork, releaseOrStopDaemon, stopDaemonForQuit, type DaemonRecoveryPort } from "./daemon-quit"
import type { DaemonRecoveryInspection } from "./daemon-recovery"
import type { DaemonFetch } from "./daemon-request"

function inspection(sessions: string[], terminals: number): DaemonRecoveryInspection {
  return {
    machineId: "local",
    generation: "generation-1",
    target: { scope: "machine", machineId: "local", ownerGeneration: "generation-1" },
    scopeRevision: "revision-1",
    owners: Array.from({ length: terminals }, (_, index) => ({
      id: `terminal-${index}`, kind: "terminal", generation: "generation-1", state: "running", pins: true,
    })),
    preview: { sessions, resources: [], summary: "" },
    residencyPins: sessions.length + terminals,
    operations: [],
    receipt: "durable",
  }
}

/** A daemon that answers its state route with `leases`, and records every path it was asked. */
function daemonHolding(leases: number | "down") {
  const asked: string[] = []
  const daemon: DaemonFetch = async (path) => {
    asked.push(path)
    if (leases === "down") throw new TypeError("fetch failed")
    if (path === "/api/claxedo/daemon/state") return Response.json({ state: "running", leases })
    return new Response(null, { status: 404 })
  }
  return { daemon, asked }
}

const unreachable: DaemonRecoveryPort = {
  inspect: async () => { throw new TypeError("fetch failed") },
  submit: async () => { throw new TypeError("fetch failed") },
  read: async () => { throw new TypeError("fetch failed") },
}

describe("quit work", () => {
  test("counts this daemon's sessions and terminals when this app is its only holder", async () => {
    const { daemon } = daemonHolding(1)
    const recovery = { ...unreachable, inspect: async () => inspection(["session-1", "session-2"], 1) }

    expect(await quitWork(daemon, recovery)).toEqual({ sessions: 2, terminals: 1 })
  })

  test("is nothing to confirm while another app holds the daemon", async () => {
    const { daemon } = daemonHolding(2)
    let inspected = false
    const recovery = { ...unreachable, inspect: async () => { inspected = true; return inspection(["session-1"], 0) } }

    expect(await quitWork(daemon, recovery)).toBeUndefined()
    expect(inspected).toBe(false)
  })

  test("names what a quit stops", () => {
    expect(quitConfirmMessage({ sessions: 0, terminals: 0 })).toBeUndefined()
    expect(quitConfirmMessage({ sessions: 1, terminals: 0 })).toBe("1 session is still working. Quitting stops it.")
    expect(quitConfirmMessage({ sessions: 2, terminals: 1 })).toBe("2 sessions and 1 terminal are still working. Quitting stops them.")
  })
})

describe("releasing or stopping the daemon on exit", () => {
  function exit(leases: number | "down", stopping: boolean, holding = true) {
    const { daemon, asked } = daemonHolding(leases)
    const order: string[] = []
    const lease = holding ? { stop: async () => { order.push("release") } } : undefined
    return {
      asked,
      order,
      run: () => releaseOrStopDaemon({
        lease,
        stop: stopping ? { daemon, run: async () => { order.push("stop") } } : undefined,
        log: () => {},
      }),
    }
  }

  test("the last holder releases its lease, then stops the daemon", async () => {
    const quit = exit(1, true)
    await quit.run()
    expect(quit.order).toEqual(["release", "stop"])
  })

  test("an app that is not the last holder only releases its lease", async () => {
    const quit = exit(3, true)
    await quit.run()
    expect(quit.order).toEqual(["release"])
  })

  test("a lease the daemon already closed is not counted as another holder", async () => {
    const quit = exit(1, true, false)
    await quit.run()
    expect(quit.order).toEqual([])
    const last = exit(0, true, false)
    await last.run()
    expect(last.order).toEqual(["stop"])
  })

  test("a daemon that cannot count its holders is stopped", async () => {
    const quit = exit("down", true)
    await quit.run()
    expect(quit.order).toEqual(["release", "stop"])
  })

  test("a handoff only releases the lease and asks the daemon nothing", async () => {
    const handoff = exit(1, false)
    await handoff.run()
    expect(handoff.order).toEqual(["release"])
    expect(handoff.asked).toEqual([])
  })
})

describe("stopping the daemon for a quit", () => {
  const operation = (state: "running" | "succeeded"): RecoveryOutcome => ({
    kind: "operation",
    operation: { operationId: "drain-1", state } as never,
  })

  test("a daemon that stops itself is not signalled", async () => {
    let exited = false
    let terminated = false
    const submitted: string[] = []
    await stopDaemonForQuit({
      recovery: {
        inspect: async () => inspection([], 0),
        submit: async (request) => {
          const action = (request as { action: string }).action
          submitted.push(action)
          if (action === "stop_daemon") exited = true
          return operation(action === "drain_daemon" ? "running" : "succeeded")
        },
        read: async () => operation("succeeded"),
      },
      exited: async () => exited,
      terminate: async () => { terminated = true },
      drainMs: 50,
      stopMs: 50,
      pollMs: 1,
    })

    expect(submitted).toEqual(["drain_daemon", "stop_daemon"])
    expect(terminated).toBe(false)
  })

  test("a daemon that crashed is checked and, still alive, signalled at once", async () => {
    const errors: unknown[] = []
    let terminated = false
    const started = Date.now()
    await stopDaemonForQuit({
      recovery: unreachable,
      exited: async () => false,
      terminate: async () => { terminated = true },
      drainMs: 2_000,
      stopMs: 10_000,
      onError: (error) => errors.push(error),
    })

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(errors).toHaveLength(1)
    expect(terminated).toBe(true)
  })

  test("a daemon that crashed and is gone is not signalled", async () => {
    let terminated = false
    await stopDaemonForQuit({
      recovery: unreachable,
      exited: async () => true,
      terminate: async () => { terminated = true },
      drainMs: 2_000,
      stopMs: 10_000,
    })

    expect(terminated).toBe(false)
  })

  test("a wedged daemon holds the quit only for the drain and stop budgets, then is signalled", async () => {
    const hang = () => new Promise<never>(() => {})
    let terminated = false
    const started = Date.now()
    await stopDaemonForQuit({
      recovery: { inspect: hang, submit: hang, read: hang },
      exited: async () => false,
      terminate: async () => { terminated = true },
      drainMs: 20,
      stopMs: 30,
    })

    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    expect(terminated).toBe(true)
  })
})
