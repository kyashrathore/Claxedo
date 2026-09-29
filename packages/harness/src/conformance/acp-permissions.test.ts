import { expect, test } from "bun:test"
import { collect, reached, wireFixture } from "./test-support/acp-wire"

function permission(id: string, sessionId: string, rawInput?: Record<string, unknown>) {
  return { jsonrpc: "2.0" as const, id, method: "session/request_permission", params: { sessionId,
    toolCall: { toolCallId: id, title: "Read file", kind: "read", ...(rawInput ? { rawInput } : {}) },
    options: [{ optionId: "always", kind: "allow_always", name: "Always" }] } }
}

test("ACP automatic permission answers preserve other state and never duplicate a saved grant", async () => {
  const f = wireFixture((_peer, message) => message.method === "session/prompt")
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    running = collect(f.transport.send(session, f.turn, f.turnBroker())).then((events) => events, (error: unknown) => error)
    await reached(() => f.peers[0]!.messages.find((row) => row.method === "session/prompt"))
    f.ports.states.set("s1", { existing: "retained" })
    const peer = f.peers[0]!
    peer.send(permission("first", session.binding.upstreamSessionId, { path: "/work/a.txt" }))
    const pending = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    expect(await f.owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    await reached(() => peer.messages.find((row) => row.id === "first"))
    peer.send(permission("second", session.binding.upstreamSessionId, { path: "/work/a.txt" }))
    expect(await reached(() => peer.messages.find((row) => row.id === "second")))
      .toMatchObject({ result: { outcome: { outcome: "selected", optionId: "always" } } })
    expect(f.ports.states.get("s1")).toEqual({ existing: "retained", brokerGrants: [expect.any(String)] })
    expect(f.ports.saved.map((row) => row.automatic)).toEqual([false, true])
    expect(f.ports.published.filter((event) => event.type === "permission.asked")).toHaveLength(1)
  } finally { await f.transport.dispose(); await running }
})

test("ACP re-asks a saved grant when the same tool title carries different input", async () => {
  const f = wireFixture((_peer, message) => message.method === "session/prompt")
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    running = collect(f.transport.send(session, f.turn, f.turnBroker())).then((events) => events, (error: unknown) => error)
    await reached(() => f.peers[0]!.messages.find((row) => row.method === "session/prompt"))
    const peer = f.peers[0]!
    peer.send(permission("granted", session.binding.upstreamSessionId, { path: "/work/a.txt" }))
    const first = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    expect(await f.owner.broker.answer(first.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    await reached(() => peer.messages.find((row) => row.id === "granted"))
    peer.send(permission("changed", session.binding.upstreamSessionId, { path: "/etc/passwd" }))
    await reached(() => f.owner.broker.list({ sessionId: "s1" })[0] ?? peer.messages.find((row) => row.id === "changed"))
    expect(peer.messages.filter((row) => row.id === "changed")).toEqual([])
    const second = f.owner.broker.list({ sessionId: "s1" })[0]!
    expect(second.request.requestId).not.toBe(first.request.requestId)
    expect(f.ports.saved.map((row) => row.automatic)).toEqual([false])
    expect(await f.owner.broker.answer(second.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(f.ports.published.filter((event) => event.type === "permission.asked")).toHaveLength(2)
  } finally { await f.transport.dispose(); await running }
})

for (const malformed of [null, {}, [null, 7, {}, ["read", "Read file"]]]) test(`ACP ignores malformed persisted grants ${JSON.stringify(malformed)}`, async () => {
  const f = wireFixture((_peer, message) => message.method === "session/prompt")
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    running = collect(f.transport.send(session, f.turn, f.turnBroker())).then((events) => events, (error: unknown) => error)
    await reached(() => f.peers[0]!.messages.find((row) => row.method === "session/prompt"))
    f.ports.states.set("s1", { brokerGrants: malformed })
    const peer = f.peers[0]!
    peer.send(permission("malformed", session.binding.upstreamSessionId))
    const pending = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    expect(f.ports.saved).toEqual([])
    expect(peer.messages.filter((row) => row.id === "malformed")).toEqual([])
    expect(await f.owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await reached(() => peer.messages.find((row) => row.id === "malformed"))).toMatchObject({ result: { outcome: { outcome: "cancelled" } } })
  } finally { await f.transport.dispose(); await running }
})

test("ACP answering inside publication releases the quiet hold and sends exactly one cancel", async () => {
  const f = wireFixture((peer, message) => {
    const prompt = peer.messages.find((row) => row.method === "session/prompt")
    if (message.method === "session/cancel" && prompt) peer.reply(prompt, { stopReason: "cancelled" })
    return message.method === "session/prompt"
  }, { promptTimeoutMs: 35 })
  const publish = f.ports.publish.bind(f.ports)
  let answer: Promise<unknown> | undefined
  f.ports.publish = async (event, pending) => {
    await publish(event, pending)
    if (pending) answer = f.owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })
  }
  try {
    const session = await f.start()
    const running = collect(f.transport.send(session, f.turn, f.turnBroker())).then(() => "completed", (error: unknown) => error)
    const peer = f.peers[0]!
    await reached(() => peer.messages.find((row) => row.method === "session/prompt"))
    peer.send(permission("instant", session.binding.upstreamSessionId))
    expect(await reached(() => peer.messages.find((row) => row.id === "instant")))
      .toMatchObject({ result: { outcome: { outcome: "selected", optionId: "always" } } })
    expect(await answer).toMatchObject({ ok: true })
    expect(await running).toMatchObject({ code: "session", detail: { acpOutcome: "uncertain" }, cause: { code: "timeout" } })
    expect(peer.messages.filter((row) => row.method === "session/cancel")).toHaveLength(1)
    expect(f.owner.broker.list({ sessionId: "s1" })).toEqual([])
    expect(f.ports.saved).toHaveLength(1)
  } finally { await f.transport.dispose() }
})

test("ACP child sessions hold no request authority, and stopping the turn settles only its own request", async () => {
  const subagents = { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } }
  const f = wireFixture((peer, message) => {
    if (message.method === "initialize") {
      peer.reply(message, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, _meta: subagents })
      return true
    }
    const prompt = peer.messages.find((row) => row.method === "session/prompt")
    if (message.method === "session/cancel" && prompt) peer.reply(prompt, { stopReason: "cancelled" })
    return message.method === "session/prompt"
  })
  const stop = new AbortController()
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    running = collect(f.transport.send(session, f.turn, f.turnBroker(stop.signal))).then(() => "completed", (error: unknown) => error)
    const peer = f.peers[0]!
    const parent = session.binding.upstreamSessionId
    await reached(() => peer.messages.find((row) => row.method === "session/prompt"))
    for (const [child, owner] of [["intermediate", parent], ["descendant", "intermediate"]] as const) {
      peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: owner,
        update: { sessionUpdate: "subagent_spawned", subagentSessionId: child, name: child, task: `${child} task` } } })
    }
    await reached(() => f.ports.subagents.length >= 2 || undefined)
    for (const child of ["intermediate", "descendant"]) peer.send(permission(child, child))
    for (const child of ["intermediate", "descendant"]) {
      expect(await reached(() => peer.messages.find((row) => row.id === child))).toMatchObject({ result: { outcome: { outcome: "cancelled" } } })
    }
    expect(f.owner.broker.list({ sessionId: "s1" })).toEqual([])
    peer.send(permission("own", parent))
    const own = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    expect(own.request.kind).toBe("permission")
    stop.abort()
    expect(await reached(() => peer.messages.find((row) => row.id === "own"))).toMatchObject({ result: { outcome: { outcome: "cancelled" } } })
    expect(await running).toBe("completed")
    expect(f.owner.broker.list({ sessionId: "s1" })).toEqual([])
    expect(f.ports.published.filter((event) => event.type === "permission.asked")).toHaveLength(1)
    expect(f.ports.saved.map((row) => row.answer)).toEqual([{ kind: "cancelled" }])
  } finally { await f.transport.dispose(); await running }
})
