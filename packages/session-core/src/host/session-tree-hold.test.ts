import { afterEach, describe, expect, test } from "bun:test"
import { FakeTransport } from "../test-support/fake-transport"
import { createHostFixture, sessionCreate, type HostFixture } from "../test-support/host-fixture"
import { holdSessionTree } from "./session-tree-hold"
import { createTurnAdmissions } from "./turn-admission"

const hosts: HostFixture[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
})

async function tree() {
  const host = createHostFixture({ transports: { pi: new FakeTransport() } })
  hosts.push(host)
  await host.runtime.sessions.create(sessionCreate({ id: "parent" }))
  await host.runtime.sessions.create({ ...sessionCreate({ id: "child" }), parentID: "parent" })
  return host
}

describe("holdSessionTree", () => {
  test("refuses a session another operation's gate holds as held, not working", async () => {
    const { store } = await tree()
    const admissions = createTurnAdmissions(store)
    const recovery = admissions.gate("child")!
    expect(holdSessionTree({ store, admissions, awaitingInput: () => false }, "parent"))
      .toEqual({ held: false, sessionId: "child", reason: "held" })
    recovery.release()
    const held = holdSessionTree({ store, admissions, awaitingInput: () => false }, "parent")
    expect(held).toMatchObject({ held: true })
    if (held.held) held.release()
  })

  test("a lease read that throws part-way releases every hold already taken, gates included", async () => {
    const { store } = await tree()
    const failing = {
      acquireTurnLease: (sessionId: string) => {
        if (sessionId === "parent") throw new Error("store unavailable")
        return store.acquireTurnLease(sessionId)
      },
      releaseTurnLease: (sessionId: string, leaseId: string) => store.releaseTurnLease(sessionId, leaseId),
    }
    const admissions = createTurnAdmissions(failing)
    expect(() => holdSessionTree({ store, admissions, awaitingInput: () => false }, "parent")).toThrow("store unavailable")
    expect(admissions.gated("child")).toBe(false)
    expect(admissions.gated("parent")).toBe(false)
    expect(store.readTurnAuthority("child")).toBeUndefined()
    expect(store.readTurnAuthority("parent")).toBeUndefined()
  })
})
