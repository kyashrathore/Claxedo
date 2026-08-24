import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { waitForClaxedoServerReady } from "../src/agent-claxedo-web-server-ready"

type FakeChild = ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null }

function child(): FakeChild {
  const process = new EventEmitter() as FakeChild
  process.exitCode = null
  process.signalCode = null
  return process
}

describe("Claxedo web server readiness", () => {
  test("resolves only from the spawned server's canonical ready message", async () => {
    const server = child()
    const ready = waitForClaxedoServerReady(server, 38593, 1_000)

    server.emit("message", { type: "unrelated", port: 38593 })
    server.emit("message", { type: "claxedo-server-ready", port: 38593 })

    await expect(ready).resolves.toBeUndefined()
  })

  test("rejects when the spawned server exits before publishing readiness", async () => {
    const server = child()
    const ready = waitForClaxedoServerReady(server, 38593, 1_000)

    server.exitCode = 1
    server.emit("exit", 1, null)

    await expect(ready).rejects.toThrow("exited before readiness")
  })

  test("rejects a ready message for a port the root did not assign", async () => {
    const server = child()
    const ready = waitForClaxedoServerReady(server, 38593, 1_000)

    server.emit("message", { type: "claxedo-server-ready", port: 38594 })

    await expect(ready).rejects.toThrow("unexpected port")
  })
})
