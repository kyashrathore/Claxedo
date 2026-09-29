import { expect, test } from "bun:test"
import type { ConnectionSecretLease } from "@claxedo/agent-runtime-contract"
import type { RuntimeConnectionDescriptor } from "../routes/config"
import { FakeTransport } from "../test-support/fake-transport"
import { MACHINE_OWNER, controlledTurn, createHostFixture, sessionCreate, tick } from "../test-support/host-fixture"
import { createWorkspaceTransports } from "./transports"

const runner = { id: "connection", access: "connection" as const }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(options: { lease?: () => Promise<ConnectionSecretLease> | ConnectionSecretLease; transport?: () => FakeTransport } = {}) {
  const connections = new Map<string, RuntimeConnectionDescriptor>([[runner.id, {
    connectionId: runner.id, providerKey: "fixture", enabled: true, configRevision: 1, config: {}, secretRefs: { token: "ref" },
  }]])
  const created: FakeTransport[] = []
  const transports = createWorkspaceTransports({
    connections: () => connections,
    resolveSecrets: options.lease ?? (() => ({ secrets: { token: "secret" }, secretLeaseGeneration: "one" })),
    composer: {
      builtIn: () => { throw new Error("unexpected native harness") },
      connection: () => { const transport = options.transport?.() ?? new FakeTransport(); created.push(transport); return transport },
    },
  })
  return { connections, created, transports, acquire: () => transports.forHarness(runner, "/repo", { owner: MACHINE_OWNER }) }
}

test("idle attached sessions revalidate descriptor and lease before each turn", async () => {
  let generation = "one"
  const f = fixture({ lease: () => ({ secrets: { token: generation }, secretLeaseGeneration: generation }) })
  const host = createHostFixture({ transports: f.transports })
  try {
    const session = await host.runtime.sessions.create(sessionCreate({ harness: runner }))
    for (const change of [() => { generation = "two" }, () => {
      f.connections.set(runner.id, { ...f.connections.get(runner.id)!, configRevision: 2, config: { command: "new" } })
    }, () => {
      f.connections.set(runner.id, { ...f.connections.get(runner.id)!, config: { url: "https://replacement.example" } })
    }]) {
      const previous = f.created.at(-1)!
      change()
      await host.runtime.turns.start({ sessionId: session.id, text: "next", origin: sessionCreate().origin })
      const idle = await host.runtime.turns.whenIdle(session.id)
      idle.abandon()
      expect(f.created.at(-1)).not.toBe(previous)
      expect(f.created.at(-1)!.attaches).toHaveLength(1)
      expect(f.created.at(-1)!.turns).toHaveLength(1)
    }
  } finally { await f.transports.disposeAll(); await host.dispose() }
})

test("shutdown drains pending leases and rejects late construction and acquisitions", async () => {
  const lease = deferred<ConnectionSecretLease>()
  const f = fixture({ lease: () => lease.promise })
  const acquiring = f.acquire().then(() => "constructed", () => "rejected")
  let drained = false
  const disposal = f.transports.disposeAll().then(() => { drained = true })
  await tick()
  const prematurelyDrained = drained
  lease.resolve({ secrets: { token: "secret" }, secretLeaseGeneration: "one" })
  const result = await acquiring
  await disposal
  expect(prematurelyDrained).toBe(false)
  expect(result).toBe("rejected")
  expect(f.created).toHaveLength(0)
  await expect(f.acquire()).rejects.toThrow()
})

test("a descriptor disabled during secret resolution cannot construct", async () => {
  const lease = deferred<ConnectionSecretLease>()
  const f = fixture({ lease: () => lease.promise })
  const acquiring = f.acquire().then(() => "constructed", () => "rejected")
  f.connections.set(runner.id, { ...f.connections.get(runner.id)!, enabled: false })
  lease.resolve({ secrets: { token: "secret" }, secretLeaseGeneration: "one" })
  try { expect(await acquiring).toBe("rejected"); expect(f.created).toHaveLength(0) }
  finally { await f.transports.disposeAll() }
})

test("retirements with equal generation keys dispose both handle identities", async () => {
  const f = fixture()
  const first = await f.acquire()
  const release = first.pin()
  f.transports.retireConnection(runner.id)
  const replacement = await f.acquire()
  expect(replacement).not.toBe(first)
  f.transports.retireConnection(runner.id)
  release()
  await f.transports.disposeAll()
  expect(f.created.map((transport) => transport.disposed)).toEqual([true, true])
})

test("failed retirement rejects shutdown and remains owned for retry", async () => {
  let attempts = 0
  const f = fixture({ transport: () => new FakeTransport({ onDispose: () => {
    attempts++
    if (attempts === 1) throw new Error("cannot stop")
  } }) })
  await f.acquire()
  const first = await f.transports.disposeAll().then(() => "success", () => "failure")
  await f.transports.disposeAll()
  expect(first).toBe("failure")
  expect(attempts).toBe(2)
})

test("steering a removed connection uses the captured executing attachment", async () => {
  const control = controlledTurn("busy")
  let steers = 0
  const f = fixture({ transport: () => new FakeTransport({ turn: () => control.events, steer: async () => {
    steers++
    return { ok: true }
  } }) })
  const host = createHostFixture({ transports: f.transports })
  try {
    await host.runtime.sessions.create(sessionCreate({ id: "busy", harness: runner }))
    await host.runtime.turns.start({ sessionId: "busy", text: "run", origin: sessionCreate().origin })
    f.connections.delete(runner.id)
    f.transports.retireConnection(runner.id)
    expect((await host.runtime.transportFor("busy")).transport).toBe(f.created[0])
    const result = await host.runtime.turns.start({ sessionId: "busy", text: "steer", delivery: "steer", origin: sessionCreate().origin })
    expect(result.steering).toMatchObject({ ok: true })
    expect(steers).toBe(1)
    expect(f.created).toHaveLength(1)
  } finally { control.finish(); await f.transports.disposeAll(); await host.dispose() }
})

for (const delivery of [undefined, "queue"] as const) test(`a ${delivery ?? "plain"} prompt racing the end of a removed connection's turn cannot inherit its attachment`, async () => {
  const control = controlledTurn("busy")
  const entered = deferred<void>()
  const resume = deferred<void>()
  let pause = false
  const f = fixture({ transport: () => new FakeTransport({ turn: () => control.events,
    beforeCapabilities: async () => { if (pause) { entered.resolve(); await resume.promise } },
  }) })
  const host = createHostFixture({ transports: f.transports })
  try {
    await host.runtime.sessions.create(sessionCreate({ id: "busy", harness: runner }))
    await host.runtime.turns.start({ sessionId: "busy", text: "first", origin: sessionCreate().origin })
    f.connections.delete(runner.id)
    f.transports.retireConnection(runner.id)
    pause = true
    const next = host.runtime.turns.start({ sessionId: "busy", text: "next", origin: sessionCreate().origin, ...(delivery ? { delivery } : {}) })
      .then(() => "admitted", () => "refused")
    await Promise.race([entered.promise, next])
    control.finish()
    const idle = await host.runtime.turns.whenIdle("busy")
    idle.abandon()
    resume.resolve()
    expect(await next).toBe("refused")
    expect(f.created[0].turns).toHaveLength(1)
  } finally { resume.resolve(); control.finish(); await host.dispose(); await f.transports.disposeAll() }
})

test("a plain prompt to a busy session is refused before any lease or attach", async () => {
  const control = controlledTurn("busy")
  let generation = "one"
  let leases = 0
  const f = fixture({
    lease: () => { leases++; return { secrets: { token: generation }, secretLeaseGeneration: generation } },
    transport: () => new FakeTransport({ turn: () => control.events }),
  })
  const host = createHostFixture({ transports: f.transports })
  try {
    await host.runtime.sessions.create(sessionCreate({ id: "busy", harness: runner }))
    await host.runtime.turns.start({ sessionId: "busy", text: "first", origin: sessionCreate().origin })
    const leased = leases
    generation = "two"
    await expect(host.runtime.turns.start({ sessionId: "busy", text: "second", origin: sessionCreate().origin }))
      .rejects.toMatchObject({ code: "session_turn_in_progress" })
    expect(leases).toBe(leased)
    expect(f.created).toHaveLength(1)
    expect(f.created[0].attaches).toHaveLength(0)
  } finally { control.finish(); await f.transports.disposeAll(); await host.dispose() }
})

test("each session owner's connection spends that owner's lease, and one owner's transport never retires another's", async () => {
  const owners: unknown[] = []
  const created: FakeTransport[] = []
  const transports = createWorkspaceTransports({
    connections: () => new Map([[runner.id, {
      connectionId: runner.id, providerKey: "fixture", enabled: true, configRevision: 1, config: {}, secretRefs: { token: "ref" },
    }]]),
    resolveSecrets: (_descriptor, _directory, { owner }) => {
      owners.push(owner)
      const holder = owner.kind === "person" ? owner.userId : "machine"
      return { secrets: { token: holder }, secretLeaseGeneration: holder }
    },
    composer: {
      builtIn: () => { throw new Error("unexpected native harness") },
      connection: () => { const transport = new FakeTransport(); created.push(transport); return transport },
    },
  })
  const host = createHostFixture({ transports })
  try {
    for (const userId of ["alice", "carol"]) {
      await host.runtime.sessions.create({ ...sessionCreate({ id: userId, harness: runner }), owner: { kind: "person", userId } })
    }
    await host.runtime.turns.start({ sessionId: "carol", text: "bob steps in", origin: { actor: { kind: "person", userId: "bob" }, via: "relay", reissued: false } })
    expect(owners).toEqual([{ kind: "person", userId: "alice" }, { kind: "person", userId: "carol" }, { kind: "person", userId: "carol" }])
    expect(created).toHaveLength(2)
    expect(created.map((transport) => transport.disposed)).toEqual([false, false])
  } finally { await transports.disposeAll(); await host.dispose() }
})
