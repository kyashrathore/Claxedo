import { afterEach, describe, expect, test } from "bun:test"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import { FakeTransport } from "../test-support/fake-transport"
import { LOOPBACK_ORIGIN, controlledTurn, createHostFixture, sessionCreate, until, type HostFixture } from "../test-support/host-fixture"

const PI: SessionHarness = { id: "pi", access: "native" }

const fixtures: HostFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

function releasing(options: ConstructorParameters<typeof FakeTransport>[0] = {}) {
  const transport = new FakeTransport({ release: async () => true, ...options })
  const fixture = createHostFixture({ transports: { pi: transport } })
  fixtures.push(fixture)
  return { ...fixture, transport }
}

describe("releasing a quiescent session's harness", () => {
  test("a created session is released at once, and its first turn attaches it again", async () => {
    const f = releasing()
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_created", harness: PI }))
    expect(f.transport.releases.map((session) => session.binding.sessionId)).toEqual([id])
    expect(f.transport.attaches).toHaveLength(0)

    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Hello" }], origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    expect(f.transport.attaches.map((attach) => attach.sessionId)).toEqual([id])
    expect(f.transport.turns).toHaveLength(1)
    await until(() => f.transport.releases.length === 2, "the settled turn releases the session")
  })

  test("a turn that is still running keeps its harness; the release follows its settling", async () => {
    const control = controlledTurn("ses_running")
    const f = releasing({ turn: () => control.events })
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_running", harness: PI }))
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Work" }], origin: LOOPBACK_ORIGIN })
    await until(() => f.transport.turns.length === 1, "the turn reaches the harness")
    expect(f.transport.releases).toHaveLength(1)

    control.finish()
    await f.runtime.turns.whenIdle(id)
    await until(() => f.transport.releases.length === 2, "the settled turn releases the session")
    expect(f.transport.closed).toHaveLength(0)
  })

  test("a release the transport refuses leaves the session attached, and the next turn runs on it without attaching again", async () => {
    const f = releasing({ release: async () => false })
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_refused", harness: PI }))
    expect(f.transport.releases).toHaveLength(1)
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Hello" }], origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    expect(f.transport.attaches).toHaveLength(0)
  })

  test("a generated title is asked of the harness before the turn's release", async () => {
    const order: string[] = []
    const f = releasing({
      naming: { generateTitle: async () => { order.push("title"); return "Named" }, rename: async () => {} },
      release: async () => { order.push("release"); return true },
    })
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_titled", harness: PI }))
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Plan" }], origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    await until(() => order.length === 3, "the titled turn releases the session")
    expect(order).toEqual(["release", "title", "release"])
    expect(f.store.getSession(id)).toMatchObject({ title: "Named", titleSource: "harness" })
  })

  test("deleting a released session closes no harness, and a transport without release is never asked", async () => {
    const f = releasing()
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_deleted", harness: PI }))
    await f.runtime.sessions.delete(id)
    expect(f.transport.closed).toHaveLength(0)
    expect(f.store.getSession(id)).toBeFalsy()

    const held = new FakeTransport()
    const g = createHostFixture({ transports: { pi: held } })
    fixtures.push(g)
    const kept = await g.runtime.sessions.create(sessionCreate({ id: "ses_kept", harness: PI }))
    await g.runtime.sessions.delete(kept.id)
    expect(held.closed.map((session) => session.binding.sessionId)).toEqual([kept.id])
  })
})
