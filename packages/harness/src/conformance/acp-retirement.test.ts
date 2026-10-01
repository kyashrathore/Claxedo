import { expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpTransport } from "../transports/acp"
import { filterMcpServers } from "../capabilities/mcp-filter"
import { createSessionBroker } from "../broker"
import { authority, origin } from "./test-support/memory-ports"
import { setupConformance } from "./test-support/run"
import { collect, reached, wireFixture } from "./test-support/acp-wire"

type Exited = Promise<{ code: number | null; signal: string | null }>
type RetirePolicy = (child: ChildProcess, exited: Exited, index: number) => Promise<{ stopped: true } | { stopped: false; error: { code: "deadline"; message: string } }>

const stop = async (child: ChildProcess, exited: Exited) => {
  child.kill("SIGTERM")
  await exited
  return { stopped: true as const }
}

async function refusingFirstRetirement() {
  const state = { attempts: 0 }
  return { ...await retirementFixture(async (child, exited) => {
    if (++state.attempts === 1) return { stopped: false, error: { code: "deadline", message: "Retirement refused" } }
    return await stop(child, exited)
  }), state }
}

async function retirementFixture(retirePeer: RetirePolicy) {
  const directory = await mkdtemp(join(tmpdir(), "acp-retirement-"))
  const children: ChildProcess[] = []
  const context = await setupConformance({ name: "ACP retirement",
    backend: async () => ({ directory, harness: { id: "acp", access: "connection" },
      model: { providerID: "acp", modelID: "default" }, owner: { kind: "machine-owner" },
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "one" }, unrunnableTurn: (turn) => turn,
      close: () => rm(directory, { recursive: true, force: true }),
      configureServices(services) {
        services.spawn = async (command) => {
          const child = spawn(command.file, [...command.args], { cwd: command.cwd, env: command.env, stdio: "pipe" })
          const index = children.push(child) - 1
          const exited: Exited = new Promise((resolve) => {
            child.once("exit", (code, signal) => resolve({ code, signal }))
          })
          return { pid: child.pid!, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
            retire: () => retirePeer(child, exited, index) }
        }
      },
    }),
    makeTransport: (services) => new AcpTransport(services, { kind: "process", command: process.execPath,
      args: [join(import.meta.dirname, "../../e2e/harness/acp/agent.ts")], env: { SCRIPTED_ACP_DIR: directory } },
      filterMcpServers, async () => { throw new Error("Unexpected restore") }),
  })
  const live = () => children.filter((child) => child.exitCode === null && child.signalCode === null)
  const release = async () => {
    for (const child of live()) child.kill("SIGKILL")
    await context.close()
  }
  return { context, live, release }
}

for (const failed of ["dispose", "close"] as const) test(`ACP dispose retries a peer whose ${failed} retirement failed`, async () => {
  const { context, state, live, release } = await refusingFirstRetirement()
  try {
    expect(live()).toHaveLength(1)
    const first = failed === "close" ? context.transport.close(context.session) : context.transport.dispose()
    await expect(first).rejects.toThrow("Retirement refused")
    expect(live()).toHaveLength(1)
    await context.transport.dispose()
    expect(state.attempts).toBe(2)
    expect(live()).toHaveLength(0)
    await context.transport.dispose()
    expect(state.attempts).toBe(2)
  } finally { await release() }
}, 30_000)

test("ACP dispose waits for every peer's retirement before reporting the one that failed", async () => {
  let releaseSlow!: () => void
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
  let slowStopped = false
  let refusals = 1
  const { context, live, release } = await retirementFixture(async (child, exited, index) => {
    if (index === 0 && refusals-- > 0) return { stopped: false, error: { code: "deadline", message: "Retirement refused" } }
    if (index === 0) return await stop(child, exited)
    await slow
    const stopped = await stop(child, exited)
    slowStopped = true
    return stopped
  })
  try {
    context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2", directory: context.backend.directory })
    context.ports.directories.set("s2", context.backend.directory)
    await context.transport.start({ ...context.start, sessionId: "s2", workspaceId: "w2" }, createSessionBroker(context.owner,
      { sessionId: "s2", workspaceId: "w2", directory: context.backend.directory, origin }))
    expect(live()).toHaveLength(2)
    let settled = false
    const disposal = context.transport.dispose().then(() => undefined, (error: unknown) => error).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    releaseSlow()
    expect(await disposal).toMatchObject({ code: "ownership", message: "Retirement refused" })
    expect(slowStopped).toBe(true)
  } finally { releaseSlow(); await release() }
}, 30_000)

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
    const attached = await f.transport.attach({ ...f.input, binding: replacement.binding, upstreamHasTurns: false }, f.sessionBroker)
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
    await expect(f.transport.attach({ ...f.input, binding: session.binding, upstreamHasTurns: false }, f.sessionBroker)).rejects.toMatchObject({ code: "ownership" })
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
      const attached = await f.transport.attach({ ...f.input, binding: session.binding, upstreamHasTurns: deferred }, f.sessionBroker)
      expect(attached.binding.upstreamSessionId).toBe(session.binding.upstreamSessionId)
      expect(f.peers.map((peer) => peer.retirements)).toEqual([1, 1, 0])
    } finally { await bounded(f.transport.dispose()) }
  })
}
