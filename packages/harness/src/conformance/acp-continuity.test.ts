import { expect, test } from "bun:test"
import { collect, reached, wireFixture } from "./test-support/acp-wire"

for (const repeated of [true, false]) test(`ACP pending config ${repeated ? 'repeated' : 'reverted'}`, async () => {
  const f = wireFixture((_peer, message) => message.method === "session/prompt")
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    const peer = f.peers[0]!
    running = collect(f.transport.send(session, f.turn, f.turnBroker()))
    const prompt = await reached(() => peer.messages.find(row => row.method === "session/prompt"))
    const changed = { projection: { ...f.input.projection, generation: "changed" } }
    expect(await f.transport.configure(session, changed)).toEqual({ state: "deferred", until: "after-active-turns" })
    const result = await f.transport.configure(session, repeated ? changed : { projection: f.input.projection })
    peer.reply(prompt, { stopReason: "end_turn" })
    await running
    if (repeated) expect(result).toEqual({ state: "deferred", until: "after-active-turns" })
    else expect(peer.retirements).toBe(0)
  } finally { await f.transport.dispose(); await running }
})

for (const operation of ["deliver", "configure", "revert", "deferred"]) test(`ACP live child after parent turn: ${operation}`, async () => {
  const f = wireFixture((peer, message) => {
    if (message.method === "initialize") {
      peer.reply(message, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } },
        _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } })
      return true
    }
    return message.method === "session/prompt"
  })
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    const peer = f.peers[0]!
    running = collect(f.transport.send(session, f.turn, f.turnBroker()))
    const prompt = await reached(() => peer.messages.find(row => row.method === "session/prompt"))
    const send = (update: unknown) => peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.binding.upstreamSessionId, update } })
    send({ sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "review", task: "review code" })
    await reached(() => f.ports.subagents.length === 1 ? true : undefined)
    if (operation === "deferred") expect(await f.transport.configure(session, { projection: { ...f.input.projection, generation: "changed" } }))
      .toEqual({ state: "deferred", until: "after-active-turns" })
    peer.reply(prompt, { stopReason: "end_turn" })
    await running
    if (operation !== "deliver") {
      await expect(f.transport.configure(session, { projection: { ...f.input.projection, generation: "changed" } }))
        .rejects.toMatchObject({ code: "configuration", message: expect.stringContaining("subagents are running") })
      expect(peer.retirements).toBe(0)
      await expect(collect(f.transport.send(session, f.turn, f.turnBroker()))).rejects.toThrow("subagents are running")
      if (operation === "revert") {
        expect(await f.transport.configure(session, { projection: f.input.projection })).toEqual({ state: "applied" })
        running = collect(f.transport.send(session, f.turn, f.turnBroker()))
        const next = await reached(() => peer.messages.filter(row => row.method === "session/prompt")[1])
        peer.reply(next, { stopReason: "end_turn" })
        await running
        expect(peer.retirements).toBe(0)
      }
      send({ sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" })
      await reached(() => f.ports.subagents.at(-1)?.status === "completed" ? true : undefined)
      expect(await f.transport.configure(session, { projection: { ...f.input.projection, generation: "changed" } })).toEqual({ state: "applied" })
      expect(peer.retirements).toBe(1)
      expect(f.peers).toHaveLength(2)
      return
    }
    peer.text("child", "late child evidence")
    send({ sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" })
    send({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "barrier", description: "ordered update barrier" }] })
    let barrier = false
    for (let attempt = 0; attempt < 100 && !barrier; attempt++) {
      barrier = (await f.transport.commands.list({ session })).some(row => row.name === "barrier")
      if (!barrier) await Bun.sleep(5)
    }
    expect(barrier).toBe(true)
    expect(f.ports.childEvents.some(row => row.event.event.type === "text-delta")).toBe(true)
    expect(f.ports.subagents.at(-1)?.status).toBe("completed")
  } finally { await f.transport.dispose(); await running }
})

test("ACP reverting configuration while earlier notifications drain cancels the waiting restart", async () => {
  const f = wireFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const publish = f.sessionBroker.publish.bind(f.sessionBroker)
  f.sessionBroker.publish = async (event, assistantMessageId) => {
    if (event.type === "available-commands-update") { entered.resolve(); await release.promise }
    return publish(event, assistantMessageId)
  }
  try {
    const session = await f.start()
    const peer = f.peers[0]!
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.binding.upstreamSessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: [] } } })
    await entered.promise
    const changing = f.transport.configure(session, { projection: { ...f.input.projection, generation: "changed" } })
    expect(await f.transport.configure(session, { projection: f.input.projection })).toEqual({ state: "applied" })
    release.resolve()
    expect(await changing).toEqual({ state: "applied" })
    expect(peer.retirements).toBe(0)
    expect((await collect(f.transport.send(session, f.turn, f.turnBroker()))).some(({ event }) => event.type === "finish")).toBe(true)
  } finally { release.resolve(); await f.transport.dispose() }
})

test("ACP title waits for queued text before removing its side-session route", async () => {
  const f = wireFixture((peer, message) => {
    if (message.method === "session/new" && peer.messages.filter(row => row.method === "session/new").length === 2) {
      peer.reply(message, { sessionId: "title-session" })
      return true
    }
    if (message.method !== "session/prompt" || message.params?.sessionId !== "title-session") return false
    peer.text("title-session", "Queued title")
    peer.reply(message, { stopReason: "end_turn" })
    return true
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const publish = f.sessionBroker.publish.bind(f.sessionBroker)
  f.sessionBroker.publish = async (event, assistantMessageId) => {
    if (event.type === "available-commands-update") { entered.resolve(); await release.promise }
    return publish(event, assistantMessageId)
  }
  try {
    const session = await f.start()
    const peer = f.peers[0]!
    peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.binding.upstreamSessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: [] } } })
    await entered.promise
    const title = f.transport.naming.generateTitle(session, { directory: f.input.directory, system: "Name this", user: "work", signal: new AbortController().signal })
    await reached(() => peer.messages.find(row => row.method === "session/prompt"))
    release.resolve()
    expect(await title).toBe("Queued title")
    expect(f.ports.childEvents).toEqual([])
  } finally { release.resolve(); await f.transport.dispose() }
})
