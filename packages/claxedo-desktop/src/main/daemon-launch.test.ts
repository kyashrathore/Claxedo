import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { readCreationIdentity } from "@claxedo/process-ownership/launch"

import { CLAXEDO_DAEMON_PROTOCOL } from "@claxedo/helpers/claxedo-daemon"
import { publishedDaemonVerdict } from "./daemon-launch"
import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

const children: Array<() => void> = []
afterEach(() => {
  for (const kill of children.splice(0)) kill()
})

/** A real process standing in for the daemon, so stopping it is observed rather than assumed. */
async function orphan(build: string) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  children.push(() => {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      // Already gone, which is what the stop tests expect.
    }
  })
  const identity = await readCreationIdentity(child.pid!)
  if (!identity) throw new Error("the stand-in daemon reported no creation identity")
  const discovery: ClaxedoDaemonDiscovery = {
    service: "claxedo-local-daemon",
    protocol: CLAXEDO_DAEMON_PROTOCOL,
    generation: "generation-1",
    token: "secret",
    pid: child.pid!,
    port: 2593,
    startedAt: "2026-10-01T00:00:00.000Z",
    build,
    identity,
  }
  return { discovery, exited, alive: () => child.exitCode === null && child.signalCode === null }
}

/** A daemon answering its identity as `record`, and its state with `leases` held by other apps. */
const answering = (record: ClaxedoDaemonDiscovery, leases = 0): typeof fetch => async (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname
  return path === "/api/claxedo/daemon/state" ? Response.json({ state: "running", leases }) : Response.json(record)
}
const silent: typeof fetch = async () => {
  throw new TypeError("connection refused")
}

function verdict(published: ClaxedoDaemonDiscovery | "unreadable", build: string, request: typeof fetch) {
  return publishedDaemonVerdict({ published, file: "/data/daemon.json", build, snapshot: () => undefined, request })
}

describe("launching over a published daemon", () => {
  test("a live daemon of this build is adopted and keeps running", async () => {
    const daemon = await orphan("1.4.0")

    expect(await verdict(daemon.discovery, "1.4.0", answering(daemon.discovery))).toEqual({
      kind: "adopt",
      url: "http://127.0.0.1:2593",
      discovery: daemon.discovery,
    })
    expect(daemon.alive()).toBe(true)
  })

  test("a live daemon of another build that another app holds is adopted and keeps running", async () => {
    const daemon = await orphan("1.4.0")

    expect(await verdict(daemon.discovery, "1.5.0", answering(daemon.discovery, 1))).toEqual({
      kind: "adopt",
      url: "http://127.0.0.1:2593",
      discovery: daemon.discovery,
    })
    expect(daemon.alive()).toBe(true)
  })

  test("a live daemon of another build that no app holds is stopped and replaced", async () => {
    const daemon = await orphan("1.4.0")

    expect(await verdict(daemon.discovery, "1.5.0", answering(daemon.discovery))).toEqual({ kind: "replace" })
    await daemon.exited
    expect(daemon.alive()).toBe(false)
  })

  test("a daemon that is not answering is held and never signalled, whatever its build", async () => {
    const daemon = await orphan("1.4.0")

    const held = await verdict(daemon.discovery, "1.5.0", silent)

    expect(held.kind === "held" && held.message).toContain("is not answering")
    expect(daemon.alive()).toBe(true)
  })

  test("a published daemon whose process is gone is replaced", async () => {
    const daemon = await orphan("1.4.0")
    process.kill(-daemon.discovery.pid, "SIGKILL")
    await daemon.exited

    expect(await verdict(daemon.discovery, "1.4.0", silent)).toEqual({ kind: "replace" })
  })

  test("a record this build cannot read is held, never taken as no daemon", async () => {
    const held = await verdict("unreadable", "1.5.0", silent)

    expect(held.kind).toBe("held")
    expect(held.kind === "held" && held.message).toContain("/data/daemon.json")
  })
})
