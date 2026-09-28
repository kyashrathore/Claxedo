import { expect, test } from "bun:test"
import { RequestError } from "@agentclientprotocol/sdk"
import type { SessionBroker, StartInput } from "@claxedo/harness/contract"
import { createHarnessComposer } from "@claxedo/harness/compose"
import { acpPeer } from "../test-support/acp-peer"
import { createHostFixture, LOOPBACK_ORIGIN, sessionCreate, until } from "../test-support/host-fixture"

function acpTransport(peer: ReturnType<typeof acpPeer>) {
  const unused = () => { throw new Error("Unused transport") }
  const composer = createHarnessComposer(peer.services, {
    acp: () => ({ missingContext: async () => ({ from: { id: "acp-test", access: "connection" }, reason: "missing-session", pending: true, transcript: "Saved recovery context" }) }),
    pi: unused, codex: unused, claude: unused, cursor: unused, opencode: unused,
  })
  return composer.connection({ descriptor: { connectionId: "acp-test", providerKey: "acp", configRevision: 1, enabled: true,
    config: { label: "Test ACP", connection: { kind: "process", command: "scripted" } } }, expectedRevision: 1, directory: "/repo", secrets: {} })
}

async function fixture() {
  const peer = acpPeer()
  const transport = acpTransport(peer)
  const host = createHostFixture({ transports: { "acp-test": transport } })
  const session = await host.runtime.sessions.create(sessionCreate({ harness: { id: "acp-test", access: "connection" } }))
  host.store.updateSessionConfig(session.id, { agent: "build", model: { providerID: "acp-test", modelID: "default" } })
  return { ...peer, ...host, transport, id: session.id }
}

test("ACP death then missing upstream restores before preparing the next prompt", async () => {
  const f = await fixture()
  try {
    const old = f.store.getAgentSessionId(f.id)
    f.peers[0].die()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await f.runtime.turns.start({ sessionId: f.id, text: "continue", origin: LOOPBACK_ORIGIN })
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    expect(f.store.getSession(f.id)?.lastTurn?.status).toBe("completed")
    expect(f.store.getAgentSessionId(f.id)).not.toBe(old)
    const prompt = f.requests.find((row) => row.method === "session/prompt")
    expect(JSON.stringify(prompt)).toContain("Saved recovery context")
    expect(f.store.getSessionConfig(f.id)?.handoff).toBeUndefined()
  } finally { await f.dispose() }
})

test("ACP prompt-result usage reaches stored assistant before completion", async () => {
  const f = await fixture()
  try {
    const frames: string[] = []
    f.eventHub.subscribeGlobal((event) => { frames.push(event.payload.type) })
    await f.runtime.turns.start({ sessionId: f.id, text: "usage", origin: LOOPBACK_ORIGIN })
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    expect(frames.indexOf("session.usage")).toBeGreaterThanOrEqual(0)
    expect(frames.indexOf("session.usage")).toBeLessThan(frames.indexOf("message.completed"))
    const messages = f.store.getMessages(f.id)
    expect(messages.find((row) => row.info.role === "assistant")?.info).toMatchObject({ tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 5, write: 4 } } })
  } finally { await f.dispose() }
})

test("ACP prompt-result usage is each prompt's own usage, as the shipped agents report it", async () => {
  const f = await fixture()
  try {
    const observed: unknown[] = []
    f.eventHub.subscribeGlobal(({ payload }) => { if (payload.type === "session.usage" && payload.properties.observation) observed.push(payload.properties.observation) })
    for (const input of [100, 50]) {
      f.setUsage({ totalTokens: input, inputTokens: input, outputTokens: 0 })
      const previous = JSON.stringify(f.store.getSession(f.id)?.lastTurn)
      await f.runtime.turns.start({ sessionId: f.id, text: "usage", origin: LOOPBACK_ORIGIN })
      await until(() => JSON.stringify(f.store.getSession(f.id)?.lastTurn) !== previous)
    }
    expect(observed).toMatchObject([{ kind: "cumulative", tokens: { input: 100 } }, { kind: "cumulative", tokens: { input: 50 } }])
  } finally { await f.dispose() }
})

test("ACP prompt-result usage keeps the context occupancy the agent reported", async () => {
  const f = await fixture()
  try {
    f.setContext({ size: 200_000, used: 1_234 })
    const usage: { contextSize: number; contextUsed: number; observation?: unknown }[] = []
    f.eventHub.subscribeGlobal(({ payload }) => { if (payload.type === "session.usage") usage.push(payload.properties) })
    await f.runtime.turns.start({ sessionId: f.id, text: "usage", origin: LOOPBACK_ORIGIN })
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    const metered = usage.filter((row) => row.observation !== undefined)
    expect(metered).toHaveLength(1)
    expect(metered[0]).toMatchObject({ contextSize: 200_000, contextUsed: 1_234 })
    expect(usage.at(-1)).toMatchObject({ contextSize: 200_000, contextUsed: 1_234 })
  } finally { await f.dispose() }
})

test("ACP connection observations do not require the optional health extension", async () => {
  const f = await fixture()
  try {
    expect(f.transport.health?.connection("/repo", f.id).state).toBe("ready")
    f.peers[0].die()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.transport.health?.connection("/repo", f.id).state).toBe("disconnected")
  } finally { await f.dispose() }
})

test("ACP fork receives child first-party MCP identity", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    await f.transport.fork!.fork(attached.session, "message", "child")
    const fork = JSON.stringify(f.requests.find((row) => row.method === "session/fork"))
    expect(fork).toContain("Bearer child")
    expect(fork).not.toContain(`Bearer ${f.id}`)
  } finally { await f.dispose() }
})

test("ACP autonomous evidence is projected and finalized through a provider turn", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    expect((await f.transport.goals!.start(attached.session, "Ship autonomously", attached.broker)).ok).toBe(true)
    await f.peers[0].connection.sessionUpdate({ sessionId: attached.session.binding.upstreamSessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Autonomous evidence" } } })
    await f.peers[0].connection.sessionUpdate({ sessionId: attached.session.binding.upstreamSessionId,
      update: { sessionUpdate: "session_info_update", _meta: { goal: { objective: "Ship autonomously", status: "complete", createdAt: 1, updatedAt: 2 } } } })
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    expect(JSON.stringify(f.store.getMessages(f.id))).toContain("Autonomous evidence")
    expect(f.store.getSession(f.id)?.lastTurn?.status).toBe("completed")
  } finally { await f.dispose() }
})

test("ACP completed prompt with no usage publishes the unavailable diagnostic", async () => {
  const f = await fixture()
  try {
    f.setUsage(undefined)
    const diagnostics: string[] = []
    f.eventHub.subscribeGlobal(({ payload }) => { if (payload.type === "runtime.diagnostic") diagnostics.push(payload.properties.code) })
    await f.runtime.turns.start({ sessionId: f.id, text: "usage", origin: LOOPBACK_ORIGIN })
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    expect(diagnostics).toContain("acp_prompt_usage_missing")
  } finally { await f.dispose() }
})

for (const [state, error] of [["auth-required", RequestError.authRequired()], ["failed", RequestError.internalError()]] as const) {
  test(`ACP session startup records ${state} without an extension`, async () => {
    const f = await fixture()
    try {
      f.failStart(error)
      const pending = f.runtime.sessions.create(sessionCreate({ id: "failure", harness: { id: "acp-test", access: "connection" } }))
      await expect(pending).rejects.toThrow()
      expect(f.transport.health!.connection("/repo", "failure").state).toBe(state)
    } finally { await f.dispose() }
  })
}

test("ACP reports connecting while session initialization has not answered", async () => {
  const f = await fixture()
  const barrier = Promise.withResolvers<void>()
  f.holdStart(barrier.promise)
  const pending = f.runtime.sessions.create(sessionCreate({ id: "connecting", harness: { id: "acp-test", access: "connection" } }))
  try {
    await until(() => f.transport.health!.connection("/repo", "connecting").state === "connecting")
    expect(f.transport.health!.connection("/repo", "connecting").processes).toHaveLength(1)
    barrier.resolve()
    await pending
    expect(f.transport.health!.connection("/repo", "connecting").state).toBe("ready")
  } finally { barrier.resolve(); await pending; await f.dispose() }
})

test("ACP autonomous peer death fails its admitted provider turn", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    await f.transport.goals!.start(attached.session, "Autonomous work", attached.broker)
    await f.peers[0].connection.sessionUpdate({ sessionId: attached.session.binding.upstreamSessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial autonomous output" } } })
    await until(() => JSON.stringify(f.store.getMessages(f.id)).includes("Partial autonomous output"))
    f.peers[0].die()
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    expect(f.store.getSession(f.id)?.lastTurn?.status).toBe("failed")
  } finally { await f.dispose() }
})

test("concurrent pre-turn restorations share one replacement binding", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    f.peers[0].die()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const [first, second] = await Promise.all([f.transport.restore!(attached.session), f.transport.restore!(attached.session)])
    expect(first.binding).toEqual(second.binding)
    expect(f.requests.filter((row) => row.method === "session/resume")).toHaveLength(1)
    expect(f.peers).toHaveLength(2)
  } finally { await f.dispose() }
})

function goalUpdate(text: string, status: "active" | "complete", iteration: number) {
  return { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text },
    _meta: { goal: { objective: "Autonomous work", status, iteration, createdAt: 1, updatedAt: iteration } } }
}

function assistantTexts(f: Awaited<ReturnType<typeof fixture>>) {
  return f.store.getMessages(f.id).filter((row) => row.info.role === "assistant").map((row) => JSON.stringify(row))
}

test("ACP content that arrives with the Goal's completion is finalized in the turn it completes", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    await f.transport.goals!.start(attached.session, "Autonomous work", attached.broker)
    const upstream = attached.session.binding.upstreamSessionId
    await f.peers[0].connection.sessionUpdate({ sessionId: upstream, update: goalUpdate("Before completion. ", "active", 1) })
    await until(() => JSON.stringify(f.store.getMessages(f.id)).includes("Before completion"))
    await f.peers[0].connection.sessionUpdate({ sessionId: upstream, update: goalUpdate("Completion evidence", "complete", 1) })
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    const texts = assistantTexts(f)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("Before completion")
    expect(texts[0]).toContain("Completion evidence")
    expect(f.store.getSession(f.id)?.lastTurn?.status).toBe("completed")
  } finally { await f.dispose() }
})

test("ACP content that is the Goal's first and last output is admitted and finalized", async () => {
  const f = await fixture()
  try {
    const diagnostics: string[] = []
    f.eventHub.subscribeGlobal(({ payload }) => { if (payload.type === "runtime.diagnostic") diagnostics.push(payload.properties.code) })
    const attached = f.runtime.attachments.peek(f.id)!
    await f.transport.goals!.start(attached.session, "Autonomous work", attached.broker)
    await f.peers[0].connection.sessionUpdate({ sessionId: attached.session.binding.upstreamSessionId, update: goalUpdate("Only evidence", "complete", 1) })
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    expect(assistantTexts(f)).toEqual([expect.stringContaining("Only evidence")])
    expect(f.store.getSession(f.id)?.lastTurn?.status).toBe("completed")
    expect(diagnostics).toContain("acp_prompt_usage_missing")
  } finally { await f.dispose() }
})

test("ACP content that arrives with the next Goal iteration opens that iteration's turn", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    await f.transport.goals!.start(attached.session, "Autonomous work", attached.broker)
    const upstream = attached.session.binding.upstreamSessionId
    await f.peers[0].connection.sessionUpdate({ sessionId: upstream, update: goalUpdate("First iteration. ", "active", 1) })
    await until(() => JSON.stringify(f.store.getMessages(f.id)).includes("First iteration"))
    await f.peers[0].connection.sessionUpdate({ sessionId: upstream, update: goalUpdate("Second iteration evidence", "active", 2) })
    await until(() => assistantTexts(f).length === 2 && assistantTexts(f)[1]?.includes("Second iteration evidence"))
    const [first] = assistantTexts(f)
    expect(first).toContain("First iteration")
    expect(first).not.toContain("Second iteration evidence")
    expect(f.store.getSession(f.id)?.lastTurn?.status).toBe("completed")
  } finally { await f.dispose() }
})

test("ACP peer that disconnects while startup adopts its session is rejected and stays disconnected", async () => {
  const peer = acpPeer()
  const transport = acpTransport(peer)
  const rebinding = Promise.withResolvers<void>()
  const rebound = Promise.withResolvers<void>()
  const broker = {
    sessionId: "adopting",
    rebind: async (upstreamSessionId: string) => {
      rebound.resolve()
      await rebinding.promise
      return { sessionId: "adopting", workspaceId: "workspace", directory: "/repo", connectionId: "acp-test", upstreamSessionId }
    },
    publish: async () => {},
  } as unknown as SessionBroker
  const input: StartInput = { sessionId: "adopting", workspaceId: "workspace", directory: "/repo", locality: "local", owner: { kind: "machine-owner" },
    config: { harness: { id: "acp-test", access: "connection" } },
    projection: { generation: "one", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: { providers: {}, secrets: {}, leaseGeneration: "one" } }
  const started = transport.start(input, broker).then(() => "adopted", () => "rejected")
  try {
    await rebound.promise
    peer.peers[0]?.die()
    await new Promise((resolve) => setTimeout(resolve, 10))
    rebinding.resolve()
    expect(await started).toBe("rejected")
    expect(transport.health!.connection("/repo", "adopting").state).toBe("disconnected")
  } finally { rebinding.resolve(); await started; await transport.dispose() }
})

test("ACP connection observations are dropped when their sessions close", async () => {
  const f = await fixture()
  try {
    for (let cycle = 0; cycle < 1000; cycle++) {
      const sessionId = `cycle-${cycle}`
      const broker = { sessionId, publish: async () => {},
        rebind: async (upstreamSessionId: string) => ({ sessionId, workspaceId: "workspace", directory: "/repo", connectionId: "acp-test", upstreamSessionId }) } as unknown as SessionBroker
      const session = await f.transport.start({ sessionId, workspaceId: "workspace", directory: "/repo", locality: "local", owner: { kind: "machine-owner" },
        config: { harness: { id: "acp-test", access: "connection" } }, projection: { generation: "one", mcpServers: [], pluginRoots: [], notApplied: [] },
        credentials: { providers: {}, secrets: {}, leaseGeneration: "one" } }, broker)
      await f.transport.close(session)
    }
    const connection = f.transport.health!.connection("/repo")
    expect(connection.processes).toHaveLength(1)
    expect(connection.state).toBe("ready")
    expect(f.transport.health!.runtime("/repo")).toEqual({ status: "ok" })
  } finally { await f.dispose() }
}, 60_000)

const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text } })

test("ACP chunks streamed right behind a Goal iteration advance all land in the new iteration's turn", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    await f.transport.goals!.start(attached.session, "Autonomous work", attached.broker)
    const upstream = attached.session.binding.upstreamSessionId
    const peer = f.peers[0]?.connection
    if (!peer) throw new Error("No ACP peer")
    await peer.sessionUpdate({ sessionId: upstream, update: goalUpdate("First iteration. ", "active", 1) })
    await until(() => JSON.stringify(f.store.getMessages(f.id)).includes("First iteration"))
    await Promise.all([
      peer.sessionUpdate({ sessionId: upstream, update: goalUpdate("SecondA ", "active", 2) }),
      peer.sessionUpdate({ sessionId: upstream, update: chunk("SecondB ") }),
      peer.sessionUpdate({ sessionId: upstream, update: chunk("SecondC") }),
    ])
    await until(() => assistantTexts(f)[1]?.includes("SecondC") ?? false)
    expect(assistantTexts(f)).toHaveLength(2)
    expect(assistantTexts(f)[1]).toContain("SecondA")
    expect(assistantTexts(f)[1]).toContain("SecondB")
    expect(f.requests.filter((row) => row.method === "session/cancel")).toEqual([])
  } finally { await f.dispose() }
})

test("ACP chunks streamed right before a Goal completion all land in the turn it completes", async () => {
  const f = await fixture()
  try {
    const attached = f.runtime.attachments.peek(f.id)!
    await f.transport.goals!.start(attached.session, "Autonomous work", attached.broker)
    const upstream = attached.session.binding.upstreamSessionId
    const peer = f.peers[0]?.connection
    if (!peer) throw new Error("No ACP peer")
    await Promise.all([
      peer.sessionUpdate({ sessionId: upstream, update: chunk("PartA ") }),
      peer.sessionUpdate({ sessionId: upstream, update: chunk("PartB ") }),
      peer.sessionUpdate({ sessionId: upstream, update: goalUpdate("PartC", "complete", 1) }),
    ])
    await until(() => !!f.store.getSession(f.id)?.lastTurn)
    const texts = assistantTexts(f)
    expect(texts).toHaveLength(1)
    for (const part of ["PartA", "PartB", "PartC"]) expect(texts[0]).toContain(part)
    expect(f.store.getSession(f.id)?.lastTurn?.status).toBe("completed")
    expect(f.requests.filter((row) => row.method === "session/cancel")).toEqual([])
  } finally { await f.dispose() }
})

test("ACP startup disconnect remains terminal and rejects adoption", async () => {
  const f = await fixture()
  const barrier = Promise.withResolvers<void>()
  f.holdStart(barrier.promise)
  const pending = f.runtime.sessions.create(sessionCreate({ id: "disconnected-start", harness: { id: "acp-test", access: "connection" } }))
  const result = pending.then(() => "adopted", () => "rejected")
  try {
    await until(() => f.peers.length === 2)
    f.peers[1].die()
    barrier.resolve()
    expect(await result).toBe("rejected")
    expect(f.transport.health!.connection("/repo", "disconnected-start").state).toBe("disconnected")
  } finally { barrier.resolve(); await result; await f.dispose() }
})
