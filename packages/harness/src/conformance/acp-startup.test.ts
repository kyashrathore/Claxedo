import { availableParallelism } from "node:os"
import { expect, test } from "bun:test"
import { reached, wireFixture } from "./test-support/acp-wire"

for (const operation of ["initialize", "session/new"] as const) test(`ACP ${operation} human wait suspends the deadline and never binds early`, async () => {
  const f = wireFixture((peer, message) => {
    if (message.method !== operation) return false
    peer.elicit("human", { requestId: message.id! })
    return true
  }, { startupTimeoutMs: 35 })
  const starting = f.start().then((session) => ({ session }), (error: unknown) => ({ error }))
  try {
    const pending = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    await Bun.sleep(110)
    expect(f.peers[0]!.retirements).toBe(0)
    expect(f.ports.bindings.size).toBe(0)
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([pending])
    for (const field of ["operationId", "directory", "workspaceId", "connectionId"] as const) {
      expect(await f.owner.broker.answer(pending.request.requestId, { kind: "form", values: { answer: "yes" } },
        { start: { ...f.binding, [field]: "forged" } })).toMatchObject({ ok: false, refusal: "foreign" })
    }
    expect(await f.owner.broker.answer(pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { start: f.binding })).toMatchObject({ ok: true })
    expect(await reached(() => f.peers[0]!.messages.find((row) => row.id === "human")))
      .toEqual({ jsonrpc: "2.0", id: "human", result: { action: "accept", content: { answer: "yes" } } })
    const request = f.peers[0]!.messages.find((row) => row.method === operation)!
    f.peers[0]!.reply(request, operation === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: "up-human" })
    expect(await starting).toHaveProperty("session")
    expect(f.ports.bindings.size).toBe(1)
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([])
  } finally { await f.transport.dispose(); await starting }
})

for (const operation of ["initialize", "session/new"] as const) test(`ACP disposal during ${operation} cancels once without binding a session`, async () => {
  const f = wireFixture((peer, message) => {
    if (message.method !== operation) return false
    peer.elicit("disposal", { requestId: message.id! })
    return true
  })
  const starting = f.start().then((session) => session, (error: unknown) => error)
  try {
    const pending = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    await f.transport.dispose()
    expect(await Promise.race([starting, Bun.sleep(100).then(() => "still initializing")])).toBeInstanceOf(Error)
    expect(f.ports.bindings.size).toBe(0)
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([])
    expect(f.ports.saved.map((row) => row.answer)).toEqual([{ kind: "cancelled" }])
    expect(await f.owner.broker.answer(pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { start: f.binding }))
      .toMatchObject({ ok: false, refusal: "stale" })
    expect(f.peers[0]!.retirements).toBe(1)
  } finally { for (const peer of f.peers) peer.exit(); await f.transport.dispose(); await starting }
})

test("ACP rejects a startup question correlated to a completed initialize RPC", async () => {
  const f = wireFixture((_peer, message) => message.method === "session/new")
  const starting = f.start().then((session) => session, (error: unknown) => error)
  try {
    await reached(() => f.peers[0]?.messages.find((row) => row.method === "session/new"))
    const peer = f.peers[0]!
    peer.elicit("late-initialize", { requestId: peer.messages.find((row) => row.method === "initialize")!.id! })
    await Bun.sleep(20)
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([])
    expect(await reached(() => peer.messages.find((row) => row.id === "late-initialize"))).toMatchObject({ error: { code: -32602 } })
  } finally { await f.transport.dispose(); await starting }
})

test("ACP rejects a late session/new question with the exact invalid-params wire code", async () => {
  const f = wireFixture()
  try {
    await f.start()
    const peer = f.peers[0]!
    peer.elicit("late-new", { requestId: peer.messages.find((row) => row.method === "session/new")!.id! })
    expect(await reached(() => peer.messages.find((row) => row.id === "late-new"))).toMatchObject({ error: { code: -32602 } })
    expect(f.ports.readPending({ sessionId: "s1" })).toEqual([])
  } finally { await f.transport.dispose() }
})

test("ACP launches beyond the machine's parallelism wait for a slot, and each startup deadline starts with its own launch", async () => {
  const limit = availableParallelism()
  const held: { peer: import("./test-support/acp-wire").WirePeer; message: import("./test-support/acp-wire").Wire }[] = []
  const f = wireFixture((peer, message) => {
    if (message.method !== "initialize") return false
    held.push({ peer, message })
    return true
  })
  const deadlines: number[] = []
  f.services.clock = { now: () => Date.now(), setTimeout: (_callback, ms) => deadlines.push(ms), clearTimeout: () => {} }
  const starts = Array.from({ length: limit + 1 }, (_, index) => f.transport.start({ ...f.input, sessionId: `s${index}` }, f.sessionBroker))
  try {
    await reached(() => held.length === limit || undefined)
    await Bun.sleep(50)
    expect(f.peers).toHaveLength(limit)
    expect(deadlines).toHaveLength(limit * 2)
    const first = held.shift()!
    first.peer.reply(first.message, { protocolVersion: 1, agentCapabilities: {} })
    await reached(() => held.length === limit || undefined)
    expect(f.peers).toHaveLength(limit + 1)
    for (const { peer, message } of held) peer.reply(message, { protocolVersion: 1, agentCapabilities: {} })
    expect(await Promise.all(starts)).toHaveLength(limit + 1)
  } finally { await f.transport.dispose(); await Promise.allSettled(starts) }
})
