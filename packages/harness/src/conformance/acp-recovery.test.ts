import { expect, test } from "bun:test"
import { catalog, collect, reached, wireFixture } from "./test-support/acp-wire"

for (const operation of ["start", "attach"] as const) test(`ACP immediate ${operation} waits for the retiring owned process`, async () => {
  const f = wireFixture()
  let release!: () => void
  let closing: Promise<void> | undefined
  let replacement: ReturnType<typeof f.start> | undefined
  try {
    const session = await f.start()
    f.peers[0]!.retirementGate = new Promise<void>((resolve) => { release = resolve })
    closing = f.transport.close(session)
    replacement = operation === "start" ? f.start() : f.transport.attach({ ...f.input, binding: session.binding, upstreamHasTurns: false }, f.sessionBroker)
    await reached(() => f.peers[0]!.retirements === 1 ? true : undefined)
    await Bun.sleep(15)
    expect(f.peers).toHaveLength(1)
    release()
    await closing
    await replacement
    expect(f.peers).toHaveLength(2)
    expect(f.peers[0]!.retirements).toBe(1)
  } finally { release?.(); await closing; await replacement; await f.transport.dispose() }
})

test("ACP cold config synchronization is bounded before any native prompt", async () => {
  const f = wireFixture((_peer, message) => message.method === "session/set_config_option", { startupTimeoutMs: 20, promptTimeoutMs: 30 })
  let running: Promise<unknown> | undefined
  let released = false
  try {
    const session = await f.transport.attach({ ...f.input, binding: { ...f.binding, upstreamSessionId: "saved" }, upstreamHasTurns: true }, f.sessionBroker)
    running = collect(f.transport.send(session, { ...f.turn, model: { providerID: "c1", modelID: "two" } }, f.turnBroker()))
      .then(() => "completed", (error: unknown) => error)
    const peer = f.peers[0]!
    await reached(() => peer.messages.find((row) => row.method === "session/set_config_option"))
    expect(await Promise.race([running, Bun.sleep(100).then(() => "unbounded sync")])).toMatchObject({ code: "timeout" })
    expect(peer.messages.filter((row) => row.method === "session/prompt")).toEqual([])
    const sync = peer.messages.find((row) => row.method === "session/set_config_option")!
    peer.reply(sync, { configOptions: catalog.map((option) => ({ ...option, currentValue: "two" })) })
    released = true
    await expect(collect(f.transport.send(session, f.turn, f.turnBroker()))).rejects.toThrow("outcome is uncertain")
    expect(peer.messages.filter((row) => row.method === "session/prompt" || row.method === "session/cancel")).toEqual([])
  } finally {
    const peer = f.peers[0]
    const sync = peer?.messages.find((row) => row.method === "session/set_config_option")
    if (sync && !released) peer!.reply(sync, { configOptions: catalog.map((option) => ({ ...option, currentValue: "two" })) })
    await running
    await f.transport.dispose()
  }
})

test("ACP config synchronization suspends its deadline for a human answer before prompting", async () => {
  const f = wireFixture((peer, message) => {
    if (message.method !== "session/set_config_option") return false
    peer.elicit("config-question", { sessionId: String(message.params!.sessionId) })
    return true
  }, { startupTimeoutMs: 30, promptTimeoutMs: 30 })
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    running = collect(f.transport.send(session, { ...f.turn, model: { providerID: "c1", modelID: "two" } }, f.turnBroker()))
      .then((events) => events, (error: unknown) => error)
    const pending = await reached(() => f.owner.broker.list({ sessionId: "s1" })[0])
    const peer = f.peers[0]!
    await Bun.sleep(100)
    expect(peer.retirements).toBe(0)
    expect(peer.messages.filter((row) => row.method === "session/prompt" || row.method === "session/cancel")).toEqual([])
    expect(await f.owner.broker.answer(pending.request.requestId, { kind: "form", values: { answer: "yes" } }, { sessionId: "s1" }))
      .toMatchObject({ ok: true })
    expect(await reached(() => peer.messages.find((row) => row.id === "config-question")))
      .toMatchObject({ result: { action: "accept", content: { answer: "yes" } } })
    peer.reply(peer.messages.find((row) => row.method === "session/set_config_option")!, {
      configOptions: catalog.map((option) => ({ ...option, currentValue: "two" })) })
    expect(await running).toEqual(expect.arrayContaining([expect.objectContaining({ event: expect.objectContaining({ type: "finish" }) })]))
    expect(peer.messages.filter((row) => row.method === "session/prompt")).toHaveLength(1)
    expect(peer.messages.filter((row) => row.method === "session/cancel")).toHaveLength(0)
  } finally { await f.transport.dispose(); await running }
})

test("ACP resumed session timeout never prompts, cancels, or binds and leaves the sibling usable", async () => {
  const f = wireFixture((_peer, message) => message.method === "session/resume", { startupTimeoutMs: 25 })
  try {
    const sibling = await f.start()
    await expect(f.transport.attach({ ...f.input, sessionId: "s2", binding: { ...f.binding, sessionId: "s2", upstreamSessionId: "saved" }, upstreamHasTurns: true }, f.sessionBroker))
      .rejects.toMatchObject({ code: "timeout", message: "ACP session restore timed out" })
    expect(f.peers.map((peer) => peer.retirements)).toEqual([0, 1])
    expect(f.peers[1]!.messages.map((row) => row.method)).toEqual(["initialize", "session/resume"])
    expect([...f.ports.bindings.keys()]).toEqual(["s1"])
    expect((await collect(f.transport.send(sibling, f.turn, f.turnBroker()))).filter((row) => row.event.type === "finish")).toHaveLength(1)
    expect(f.peers).toHaveLength(2)
  } finally { await f.transport.dispose() }
})

test("ACP exact-session health never promotes another directory to ready", async () => {
  const f = wireFixture((peer, message) => {
    if (message.method !== "initialize") return false
    peer.reply(message, { protocolVersion: 1, agentCapabilities: {}, _meta: { claxedo: { version: 1, health: true } } })
    return true
  })
  try {
    await f.start()
    expect(f.transport.health?.connection("/work", "s1").state).toBe("ready")
    expect(f.transport.health?.connection("/other", "s1").state).toBe("disconnected")
    expect(f.transport.health?.runtime("/work", "s1").status).toBe("ok")
    expect(f.transport.health?.runtime("/other", "s1").status).toBe("unavailable")
  } finally { await f.transport.dispose() }
})
