import { expect, test } from "bun:test"
import { scriptedTransport } from "./test-support/transport"

test("a Codex process lost under a session reads degraded until its replacement starts, and each change is reported once", async () => {
  const peer = await scriptedTransport()
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "ok" })
    peer.exitLatest()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "degraded", reason: "harness_process_lost", message: "Codex app-server exited with code 1" })
    expect(peer.healthChanges.count).toBe(1)
    await peer.transport.attach({ ...peer.startInput, binding: session.binding, upstreamHasTurns: false }, peer.liveBroker())
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "ok" })
    expect(peer.healthChanges.count).toBe(2)
  } finally { await peer.close() }
})

test("closing a Codex session retires its process without reading as a loss", async () => {
  const peer = await scriptedTransport()
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    await peer.transport.close(session)
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "ok" })
    expect(peer.transport.health.connection(peer.root, "s1").state).toBe("disconnected")
    expect(peer.healthChanges.count).toBe(0)
  } finally { await peer.close() }
})
