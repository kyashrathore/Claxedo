import { expect, test } from "bun:test"
import { collect, reached, wireFixture } from "./test-support/acp-wire"

async function bounded<T>(work: Promise<T>): Promise<T | "pending"> {
  return Promise.race([work, Bun.sleep(200).then(() => "pending" as const)])
}

for (const deferred of [false, true]) test(`ACP close during ${deferred ? "deferred" : "immediate"} restart suppresses replacement and settles disposal`, async () => {
  const f = wireFixture((_peer, message) => deferred && message.method === "session/prompt")
  let release!: () => void
  let running: Promise<unknown> | undefined
  try {
    const session = await f.start()
    const peer = f.peers[0]!
    if (deferred) {
      running = collect(f.transport.send(session, f.turn, f.turnBroker()))
      await reached(() => peer.messages.find((row) => row.method === "session/prompt"))
    }
    peer.retirementGate = new Promise<void>((resolve) => { release = resolve })
    const configuring = f.transport.configure(session, { credentials: { ...f.input.credentials, leaseGeneration: "g2" } })
      .then((result) => ({ result }), (error: unknown) => ({ error }))
    if (deferred) {
      expect(await configuring).toEqual({ result: { state: "deferred", until: "after-active-turns" } })
      peer.reply(peer.messages.find((row) => row.method === "session/prompt")!, { stopReason: "end_turn" })
      await running
    }
    await reached(() => peer.retirements === 1 ? true : undefined)
    const closing = f.transport.close(session)
    release()
    expect(await bounded(closing)).toBeUndefined()
    expect(await bounded(configuring)).not.toBe("pending")
    expect(f.peers).toHaveLength(1)
    expect(peer.retirements).toBe(1)
    expect(await bounded(f.transport.dispose())).toBeUndefined()
  } finally {
    release?.()
    for (const peer of f.peers) peer.exit()
    await bounded(f.transport.dispose())
  }
})

for (const invalid of ["stale", "repeated"] as const) test(`ACP ${invalid} close cannot poison a later start or attach`, async () => {
  const f = wireFixture()
  try {
    const session = await f.start()
    if (invalid === "repeated") await f.transport.close(session)
    const handle = invalid === "stale" ? { ...session, binding: { ...session.binding, upstreamSessionId: "foreign" } } : session
    await expect(Promise.resolve().then(() => f.transport.close(handle))).rejects.toThrow("not attached")
    expect(f.peers[0]!.retirements).toBe(invalid === "stale" ? 0 : 1)
    if (invalid === "stale") await f.transport.close(session)
    const replacement = await f.start()
    await f.transport.close(replacement)
    const attached = await f.transport.attach({ ...f.input, binding: replacement.binding }, f.sessionBroker)
    expect(attached.binding).toEqual(replacement.binding)
    expect(f.peers).toHaveLength(3)
    expect(f.peers.map((peer) => peer.retirements)).toEqual([1, 1, 0])
  } finally { await f.transport.dispose() }
})

for (const operation of ["initialize", "session/resume"] as const) test(`ACP close interrupts replacement ${operation} during restart`, async () => {
  const f = wireFixture((peer, message) => {
    if (peer.number !== 2 || message.method !== operation) return false
    if (operation === "initialize") peer.elicit("restart-question", { requestId: message.id! })
    return true
  })
  try {
    const session = await f.start()
    const configuring = f.transport.configure(session, { credentials: { ...f.input.credentials, leaseGeneration: "g2" } })
      .then((result) => ({ result }), (error: unknown) => ({ error }))
    await reached(() => f.peers[1]?.messages.find((row) => row.method === operation))
    expect(await bounded(f.transport.close(session))).toBeUndefined()
    expect(await bounded(configuring)).not.toBe("pending")
    expect(f.peers.map((peer) => peer.retirements)).toEqual([1, 1])
    expect(f.peers[1]!.messages.filter((row) => row.method === "session/prompt")).toHaveLength(0)
    expect(await bounded(f.transport.dispose())).toBeUndefined()
  } finally {
    for (const peer of f.peers) peer.exit()
    await bounded(f.transport.dispose())
  }
})

test("ACP stale handle cannot join an owned close already in progress", async () => {
  const f = wireFixture()
  let release!: () => void
  try {
    const session = await f.start()
    f.peers[0]!.retirementGate = new Promise<void>((resolve) => { release = resolve })
    const closing = f.transport.close(session)
    const stale = { ...session, binding: { ...session.binding, upstreamSessionId: "foreign" } }
    const refused = Promise.resolve().then(() => f.transport.close(stale)).then(() => "accepted", (error: unknown) => error)
    expect(await bounded(refused)).toMatchObject({ code: "session", message: "ACP session is not attached" })
    release()
    await closing
    expect(f.peers[0]!.retirements).toBe(1)
    expect((await f.start()).binding.upstreamSessionId).toBe("up-2")
  } finally { release?.(); await bounded(f.transport.dispose()) }
})

for (const operation of ["close", "restart"] as const) test(`ACP fences an unverified retirement after ${operation} fails and retries it on close and dispose`, async () => {
  const f = wireFixture()
  let retirements = 0
  try {
    const session = await f.start()
    const process = f.services.processes[0]!
    const retire = process.retire.bind(process)
    process.retire = async (deadline) => {
      if (++retirements > 1) return retire(deadline)
      return { stopped: false, error: { code: "deadline", message: "writer remains alive" } }
    }
    const failed = operation === "close" ? f.transport.close(session)
      : f.transport.configure(session, { credentials: { ...f.input.credentials, leaseGeneration: "g2" } })
    await expect(failed).rejects.toMatchObject({ code: "ownership", message: "writer remains alive" })
    await expect(f.start()).rejects.toMatchObject({ code: "ownership" })
    await expect(f.transport.attach({ ...f.input, binding: session.binding }, f.sessionBroker)).rejects.toMatchObject({ code: "ownership" })
    await expect(collect(f.transport.send(session, f.turn, f.turnBroker()))).rejects.toMatchObject({ code: "ownership" })
    expect(retirements).toBe(1)
    if (operation === "close") {
      await expect(f.transport.close(session)).resolves.toBeUndefined()
      expect(retirements).toBe(2)
      expect((await f.start()).binding.upstreamSessionId).toBe("up-2")
    } else {
      await expect(f.transport.dispose()).resolves.toBeUndefined()
      expect(retirements).toBe(2)
      expect(f.peers).toHaveLength(1)
    }
  } finally { await Promise.allSettled([bounded(f.transport.dispose())]) }
})

test("ACP dispose during restart retirement suppresses the replacement and settles", async () => {
  const f = wireFixture()
  let release!: () => void
  try {
    const session = await f.start()
    const peer = f.peers[0]!
    peer.retirementGate = new Promise<void>((resolve) => { release = resolve })
    const configuring = f.transport.configure(session, { credentials: { ...f.input.credentials, leaseGeneration: "g2" } })
      .then((result) => ({ result }), (error: unknown) => ({ error }))
    await reached(() => peer.retirements === 1 ? true : undefined)
    const disposing = f.transport.dispose()
    release()
    expect(await bounded(disposing)).toBeUndefined()
    expect(await bounded(configuring)).toMatchObject({ error: { code: "session", message: "ACP session is closing" } })
    expect(f.peers).toHaveLength(1)
    expect(peer.retirements).toBe(1)
  } finally {
    release?.()
    for (const peer of f.peers) peer.exit()
    await bounded(f.transport.dispose())
  }
})

for (const deferred of [false, true]) for (const failure of ["session/resume", "initialize"] as const) {
  test(`ACP ${deferred ? "deferred" : "immediate"} restart whose replacement fails at ${failure} reports it and stays closeable`, async () => {
    const f = wireFixture((peer, message) => {
      if (peer.number === 1 && message.method === "session/prompt") return deferred
      if (peer.number !== 2 || message.method !== failure) return false
      if (failure === "initialize") peer.exit({ code: 1, signal: null })
      else peer.fail(message, -32603, "resume refused")
      return true
    })
    try {
      const session = await f.start()
      const update = { credentials: { ...f.input.credentials, leaseGeneration: "g2" } }
      if (deferred) {
        const running = collect(f.transport.send(session, f.turn, f.turnBroker()))
        const prompt = await reached(() => f.peers[0]!.messages.find((row) => row.method === "session/prompt"))
        expect(await f.transport.configure(session, update)).toEqual({ state: "deferred", until: "after-active-turns" })
        f.peers[0]!.reply(prompt, { stopReason: "end_turn" })
        await running
        expect(await reached(() => f.ports.failures[0])).toBeInstanceOf(Error)
      } else {
        const configured = await f.transport.configure(session, update).then((result) => ({ result }), (error: unknown) => ({ error }))
        expect(configured).toMatchObject({ error: expect.any(Error) })
      }
      await expect(collect(f.transport.send(session, f.turn, f.turnBroker()))).rejects.toThrow("ACP session restart failed")
      expect(await bounded(f.transport.close(session))).toBeUndefined()
      await expect(f.transport.close(session)).rejects.toThrow("not attached")
      const attached = await f.transport.attach({ ...f.input, binding: session.binding }, f.sessionBroker)
      expect(attached.binding.upstreamSessionId).toBe(session.binding.upstreamSessionId)
      expect(f.peers.map((peer) => peer.retirements)).toEqual([1, 1, 0])
    } finally { await bounded(f.transport.dispose()) }
  })
}
