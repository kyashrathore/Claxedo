import { expect, test } from "bun:test"
import { collect, reached, wireFixture } from "./test-support/acp-wire"

for (const operation of ["initialize", "session/new"] as const) test(`ACP ${operation} timeout retires once before any binding`, async () => {
  const f = wireFixture((_peer, message) => message.method === operation, { startupTimeoutMs: 30 })
  try {
    await expect(f.start()).rejects.toMatchObject({ code: "timeout", message: `ACP ${operation} timed out` })
    expect(f.ports.bindings.size).toBe(0)
    expect(f.peers).toHaveLength(1)
    expect(f.peers[0]!.retirements).toBe(1)
    expect(f.peers[0]!.messages.filter((row) => row.method === "session/prompt")).toEqual([])
    await f.transport.dispose()
    expect(f.peers[0]!.retirements).toBe(1)
  } finally { await f.transport.dispose() }
})

for (const operation of ["initialize", "session/new"] as const) test(`ACP concurrent failed draft ${operation} shares one peer and recovers on retry`, async () => {
  const f = wireFixture((peer, message) => peer.number === 1 && message.method === operation, { startupTimeoutMs: 30 })
  try {
    const results = await Promise.allSettled([f.transport.config.options({ draft: f.input }, "probe"),
      f.transport.config.options({ draft: f.input }, "probe")])
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "timeout" })
    expect(f.peers).toHaveLength(1)
    expect(f.peers[0]!.messages.filter((row) => row.method === operation)).toHaveLength(1)
    expect(f.peers[0]!.retirements).toBe(1)
    expect(await f.transport.config.options({ draft: f.input }, "probe")).toMatchObject({ resolvedModel: { id: "one" } })
    expect(f.peers).toHaveLength(2)
    expect(f.peers.map((peer) => peer.retirements)).toEqual([1, 1])
  } finally { await f.transport.dispose() }
})

test("ACP bounds a draft probe while spawn is unresolved", async () => {
  const f = wireFixture(undefined, { startupTimeoutMs: 20 })
  const spawn = f.services.spawn.bind(f.services)
  let release!: () => void
  f.services.spawn = async (...args) => { await new Promise<void>((resolve) => { release = resolve }); return spawn(...args) }
  const probe = f.transport.config.options({ draft: f.input }, "probe").then(() => "completed", (error: unknown) => error)
  try {
    const result = await Promise.race([probe, Bun.sleep(100).then(() => "unbounded")])
    expect(result).toMatchObject({ code: "timeout" })
  } finally {
    release()
    await probe
    await reached(() => f.peers[0]?.retirements === 1 ? true : undefined)
    await f.transport.dispose()
    expect(f.peers[0]!.messages).toEqual([])
    expect(f.peers[0]!.retirements).toBe(1)
  }
})

test("ACP prompt rejection preserves its peer, sends no cancel, and admits the next prompt", async () => {
  let prompts = 0
  const f = wireFixture((peer, message) => {
    if (message.method !== "session/prompt" || ++prompts !== 1) return false
    peer.fail(message, -32603, "original prompt failure")
    return true
  })
  try {
    const session = await f.start()
    await expect(collect(f.transport.send(session, f.turn, f.turnBroker()))).rejects.toMatchObject({ message: expect.stringContaining("original prompt failure") })
    expect(f.peers).toHaveLength(1)
    expect(f.peers[0]!.retirements).toBe(0)
    expect(f.peers[0]!.messages.filter((row) => row.method === "session/cancel")).toEqual([])
    expect((await collect(f.transport.send(session, f.turn, f.turnBroker()))).filter((row) => row.event.type === "finish")).toHaveLength(1)
    expect(prompts).toBe(2)
    expect(f.peers[0]!.retirements).toBe(0)
  } finally { await f.transport.dispose() }
})

test("ACP streams eight updates across multiple quiet countdowns", async () => {
  const f = wireFixture((_peer, message) => message.method === "session/prompt", { promptTimeoutMs: 80 })
  try {
    const session = await f.start()
    const running = collect(f.transport.send(session, f.turn, f.turnBroker()))
    const outcome = running.then((events) => ({ events }), (error: unknown) => ({ error }))
    const peer = f.peers[0]!
    const prompt = await reached(() => peer.messages.find((row) => row.method === "session/prompt"))
    for (let index = 0; index < 8; index++) { peer.text(session.binding.upstreamSessionId, String(index)); await Bun.sleep(25) }
    peer.reply(prompt, { stopReason: "end_turn" })
    const result = await outcome
    expect(result).not.toHaveProperty("error")
    if (!("events" in result)) throw new Error("Stream failed")
    expect(result.events.filter((row) => row.event.type === "text-delta").map((row) => row.event.type === "text-delta" && row.event.delta))
      .toEqual(["0", "1", "2", "3", "4", "5", "6", "7"])
    expect(peer.messages.filter((row) => row.method === "session/cancel")).toEqual([])
  } finally { await f.transport.dispose() }
})

test("ACP deferred config waits for the turn and retirement before accepting the next prompt", async () => {
  const f = wireFixture((peer, message) => peer.number === 1 && message.method === "session/prompt")
  let release!: () => void
  try {
    const session = await f.start()
    const peer = f.peers[0]!
    const running = collect(f.transport.send(session, f.turn, f.turnBroker()))
    const prompt = await reached(() => peer.messages.find((row) => row.method === "session/prompt"))
    expect(await f.transport.configure(session, { projection: { ...f.input.projection, generation: "plugins:g2" } }))
      .toEqual({ state: "deferred", until: "after-active-turns" })
    expect(peer.retirements).toBe(0)
    peer.retirementGate = new Promise<void>((resolve) => { release = resolve })
    peer.reply(prompt, { stopReason: "end_turn" })
    await running
    expect(peer.retirements).toBe(1)
    const next = collect(f.transport.send(session, f.turn, f.turnBroker()))
    await Bun.sleep(10)
    expect(f.peers).toHaveLength(1)
    release()
    expect((await next).filter((row) => row.event.type === "finish")).toHaveLength(1)
    expect(f.peers).toHaveLength(2)
    expect(f.peers[1]!.messages.filter((row) => row.method === "session/resume")).toHaveLength(1)
    expect(f.peers.flatMap((item) => item.messages).filter((row) => row.method === "session/cancel")).toEqual([])
    expect(await f.transport.configure(session, { projection: { ...f.input.projection, generation: "plugins:g2" } })).toEqual({ state: "applied" })
    expect(f.peers).toHaveLength(2)
  } finally { release?.(); await f.transport.dispose() }
})

test("ACP an already-exited launch retires once and preserves exit code 17", async () => {
  const f = wireFixture((peer, message) => {
    if (message.method !== "initialize") return false
    peer.exit({ code: 17, signal: null })
    return true
  })
  try {
    await expect(f.start()).rejects.toMatchObject({ code: "connection", message: "ACP initialization failed after process exited with code 17" })
    expect(f.peers).toHaveLength(1)
    expect(f.peers[0]!.retirements).toBe(1)
    expect(f.ports.bindings.size).toBe(0)
    await f.transport.dispose()
    expect(f.peers[0]!.retirements).toBe(1)
  } finally { await f.transport.dispose() }
})
