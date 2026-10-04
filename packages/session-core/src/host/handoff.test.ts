import { afterEach, describe, expect, test } from "bun:test"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import { FakeTransport } from "../test-support/fake-transport"
import { LOOPBACK_ORIGIN, createHostFixture, sessionCreate, type HostFixture } from "../test-support/host-fixture"

const PI: SessionHarness = { id: "pi", access: "native" }
const CLAUDE: SessionHarness = { id: "claude", access: "native" }
const CODEX: SessionHarness = { id: "codex", access: "native" }

const fixtures: HostFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

function harnesses() {
  const transport = (id: string) => new FakeTransport({ upstreamSessionId: (input) => `${id}-upstream-${input.sessionId}` })
  const transports = { pi: transport("pi"), claude: transport("claude"), codex: transport("codex") }
  const fixture = createHostFixture({ transports })
  fixtures.push(fixture)
  return { ...fixture, ...transports }
}

const closedUpstreams = (transport: FakeTransport) => transport.closed.map((session) => session.binding.upstreamSessionId)

describe("harness switches before a message is sent on the new harness", () => {
  test("the next harness receives public partial work and attributed messages without private reasoning", async () => {
    const source = new FakeTransport({ turn: async function* ({ turn, session }) {
      yield { type: "thinking-delta", delta: "PRIVATE_HANDOFF_THOUGHT" }
      yield { type: "text-delta", delta: `Public work for ${turn.userMessageId}` }
      if (turn.userMessageId === "msg_first") yield { type: "error", error: "provider failed after partial work" }
      else yield { type: "finish", sessionId: session.binding.sessionId }
    } })
    const target = new FakeTransport()
    const f = createHostFixture({ transports: { pi: source, codex: target } })
    fixtures.push(f)
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_public_handoff", harness: PI }))
    await f.runtime.turns.start({ sessionId: id, messageId: "msg_first", text: "Human request", origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    await f.runtime.turns.start({ sessionId: id, messageId: "msg_child", text: "Child result", author: { id: "child", name: "Reviewer", kind: "agent" }, origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    await f.runtime.sessions.updateConfig(id, { harness: CODEX })
    await f.runtime.turns.start({ sessionId: id, messageId: "msg_continue", text: "Continue", origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    const system = target.turns[0]?.turn.system ?? ""
    expect(system).not.toContain("PRIVATE_HANDOFF_THOUGHT")
    expect(system).toContain("Public work for msg_first")
    expect(system).toContain("[Turn ended:")
    expect(system).toContain('Agent "Reviewer":')
    expect(system).not.toContain("(child)")
    expect(system.indexOf("Human request")).toBeLessThan(system.indexOf("Public work for msg_first"))
    expect(system.indexOf("Public work for msg_first")).toBeLessThan(system.indexOf("Child result"))
    expect(system.indexOf("Child result")).toBeLessThan(system.indexOf("Public work for msg_child"))
  })

  test("a harness picked in between is released and the conversation's source stays kept until delete", async () => {
    const f = harnesses()
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_chain", harness: PI }))
    await f.runtime.sessions.updateConfig(id, { harness: CLAUDE })
    const second = await f.runtime.sessions.updateConfig(id, { harness: CODEX })

    expect(closedUpstreams(f.claude)).toEqual(["claude-upstream-ses_chain"])
    expect(closedUpstreams(f.pi)).toEqual([])
    expect(second.handoff?.from).toEqual(PI)
    expect(second.handoff?.source?.upstreamSessionId).toBe("pi-upstream-ses_chain")

    await f.runtime.sessions.delete(id)
    expect(closedUpstreams(f.pi)).toEqual(["pi-upstream-ses_chain"])
    expect(closedUpstreams(f.codex)).toEqual(["codex-upstream-ses_chain"])
    expect(closedUpstreams(f.claude)).toEqual(["claude-upstream-ses_chain"])
    expect(f.pi.attaches).toEqual([])
  })

  test("picking the left harness back resumes its kept session and releases only the one picked in between", async () => {
    const f = harnesses()
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_back", harness: PI }))
    await f.runtime.sessions.updateConfig(id, { harness: CLAUDE })
    await f.runtime.sessions.updateConfig(id, { harness: CODEX })
    const restored = await f.runtime.sessions.updateConfig(id, { harness: PI })

    expect(restored.harness).toEqual(PI)
    expect(restored.handoff).toBeUndefined()
    expect(closedUpstreams(f.claude)).toEqual(["claude-upstream-ses_back"])
    expect(closedUpstreams(f.codex)).toEqual(["codex-upstream-ses_back"])
    expect(closedUpstreams(f.pi)).toEqual([])

    await f.runtime.turns.start({ sessionId: id, messageId: "msg_back", text: "back on pi", origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    expect(f.pi.turns.map((turn) => turn.session.binding.upstreamSessionId)).toEqual(["pi-upstream-ses_back"])
    expect(f.pi.attaches).toEqual([])

    await f.runtime.sessions.delete(id)
    expect(closedUpstreams(f.pi)).toEqual(["pi-upstream-ses_back"])
  })
})
