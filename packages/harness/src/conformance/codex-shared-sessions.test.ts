import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { PassThrough } from "node:stream"
import { codexBackend, codexOptions, entryHome, hashes, OWNER_KEY, ownLoginContext, type CodexBackend } from "../../e2e/harness/codex-conformance"
import { createSessionBroker, createTurnBroker } from "../broker"
import type { PluginProjection, ResolvedCredentials, RoutedEvent, SessionBroker } from "../contract"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import { authority, origin } from "./test-support/memory-ports"
import { setupConformance } from "./test-support/run"
import { createTestServices, type TestServices } from "./test-support/services"

type Context = Awaited<ReturnType<typeof ownLoginContext>>["context"]

async function reply(context: Context, marker: string) {
  const text: string[] = []
  for await (const routed of context.transport.send(context.session, context.turn(`Reply with exactly this one token: ${marker}`), context.turnBroker())) {
    if (routed.event.type === "text-delta") text.push(routed.event.delta)
  }
  const request = (context.backend as CodexBackend).server.requests.find((row) => row.prompt.includes(marker))
  return { text: text.join(""), prompt: request?.prompt ?? "", authorization: request?.authorization ?? "" }
}

test("a Codex session keeps its thread and goal when its plugin selection mode and then its account switch, and back again", async () => {
  const { context, ownerHome } = await ownLoginContext("codex-shared-sessions")
  try {
    const state = context.backend as CodexBackend
    const before = await hashes(ownerHome)
    const ownLogin = context.start.credentials
    const brokered: ResolvedCredentials = { ...ownLogin, providers: { openai: { baseUrl: state.server.v1Url, placeholder: "switched-account", authMode: "api-key" } } }
    const selected: PluginProjection = { ...context.start.projection, generation: "g2", pluginSelection: { mode: "selected", selectionHash: "one" } }
    const first = await reply(context, "OWNLOGIN")
    expect(first.authorization).toContain(OWNER_KEY)
    const ownHome = entryHome(context.transport, "s1")
    const started = await context.transport.goals!.start(context.session, "Reply with exactly this one token: GOALKEPT", context.sessionBroker)
    expect(started.ok).toBe(true)
    expect((await context.transport.goals!.pause(context.session)).ok).toBe(true)

    expect(await context.transport.configure(context.session, { projection: selected })).toEqual({ state: "applied" })
    const selectedHome = entryHome(context.transport, "s1")
    expect(selectedHome).not.toBe(ownHome)
    const afterMode = await reply(context, "SELECTEDMODE")
    expect(afterMode.text).toContain("SELECTEDMODE")
    expect(afterMode.prompt).toContain("OWNLOGIN")
    expect(await context.transport.goals!.read(context.session)).toMatchObject({ objective: "Reply with exactly this one token: GOALKEPT", status: "paused" })

    expect(await context.transport.configure(context.session, { credentials: brokered })).toEqual({ state: "applied" })
    expect([ownHome, selectedHome]).not.toContain(entryHome(context.transport, "s1"))
    const afterAccount = await reply(context, "STOREDACCOUNT")
    expect(afterAccount.text).toContain("STOREDACCOUNT")
    expect(afterAccount.prompt).toContain("OWNLOGIN")
    expect(afterAccount.prompt).toContain("SELECTEDMODE")
    expect(afterAccount.authorization).toContain("switched-account")
    expect(await context.transport.goals!.read(context.session)).toMatchObject({ objective: "Reply with exactly this one token: GOALKEPT", status: "paused" })

    expect(await context.transport.configure(context.session, { credentials: ownLogin, projection: { ...context.start.projection, generation: "g3" } })).toEqual({ state: "applied" })
    expect(entryHome(context.transport, "s1")).toBe(ownHome)
    const back = await reply(context, "BACKHOME")
    expect(back.text).toContain("BACKHOME")
    expect(back.prompt).toContain("STOREDACCOUNT")
    expect(back.authorization).toContain(OWNER_KEY)
    expect(await context.transport.goals!.read(context.session)).toMatchObject({ objective: "Reply with exactly this one token: GOALKEPT", status: "paused" })
    expect(await hashes(ownerHome)).toEqual(before)
  } finally { await context.close() }
}, 180_000)

type Shared = Awaited<ReturnType<typeof sharedWorkspace>>

function binding(state: CodexBackend, workspaceId: string, credentialId: string): ResolvedCredentials {
  return { ...state.credentials, providers: { openai: { baseUrl: `${state.server.url}/bindings/${workspaceId}`, placeholder: `placeholder-${workspaceId}`,
    authMode: "api-key", account: { credentialId, providerId: "openai" } } } }
}

async function sharedWorkspace(name: string, accounts: [string, string], options: { idleMs?: number; prepare?: (services: TestServices) => void } = {}) {
  const state = await codexBackend()
  const context = await setupConformance({ name, makeTransport: (services, backend) => {
    options.prepare?.(services)
    return new CodexAppServerTransport(services, codexOptions(backend, { idleMs: options.idleMs ?? 0 }))
  }, backend: async () => ({ ...state, credentials: binding(state, "w1", accounts[0]) }) })
  context.ports.current.set("s2", { ...authority, sessionId: "s2", directory: state.directory })
  context.ports.directories.set("s2", state.directory)
  const broker = createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w1", directory: state.directory, origin })
  const second = await context.transport.start({ ...context.start, sessionId: "s2", credentials: binding(state, "w1", accounts[1]) }, broker)
  return { state, context, second, processes: () => context.services.processes, close: () => context.close(),
    secondTurn: (message: string) => ({ ...context.turn(message), turnId: `b-${message}` }),
    secondBroker: () => createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!, origin, signal: new AbortController().signal }) }
}

async function text(stream: AsyncIterable<RoutedEvent>): Promise<string> {
  const deltas: string[] = []
  for await (const routed of stream) if (routed.event.type === "text-delta") deltas.push(routed.event.delta)
  return deltas.join("")
}

const marked = (marker: string) => `Reply with exactly this one token: ${marker}`
const first = (w: Shared, marker: string) => text(w.context.transport.send(w.context.session, w.context.turn(marked(marker)), w.context.turnBroker()))
const other = (w: Shared, marker: string) => text(w.context.transport.send(w.second, w.secondTurn(marked(marker)), w.secondBroker()))
const authorizations = (state: CodexBackend, marker: string) => state.server.requests.filter((request) => request.prompt.includes(marker)).map((request) => request.authorization)

function aliveAfter(process: TestServices["processes"][number], ms: number) {
  return Promise.race([process.exited.then(() => "exited"), new Promise((resolve) => setTimeout(() => resolve("alive"), ms))])
}

test("two sessions of one workspace, owner and account share one app-server; a different account gets its own", async () => {
  const same = await sharedWorkspace("codex-share-same", ["account-one", "account-one"])
  try {
    expect(await first(same, "SHAREDA")).toContain("SHAREDA")
    expect(await other(same, "SHAREDB")).toContain("SHAREDB")
    expect(same.processes()).toHaveLength(1)
    expect(await fs.readdir(entryHome(same.context.transport, "s1"))).not.toContain("auth.json")
    expect(authorizations(same.state, "SHARED")).toEqual(["Bearer placeholder-w1", "Bearer placeholder-w1"])
  } finally { await same.close() }
  const split = await sharedWorkspace("codex-share-split", ["account-one", "account-two"])
  try {
    expect(await first(split, "SPLITA")).toContain("SPLITA")
    expect(await other(split, "SPLITB")).toContain("SPLITB")
    expect(new Set(split.processes().map((process) => process.pid)).size).toBe(2)
  } finally { await split.close() }
}, 180_000)

test("two workspaces of one owner and account keep separate app-servers, and disposing one leaves the other's session running", async () => {
  const w = await sharedWorkspace("codex-share-workspaces", ["account-one", "account-one"])
  const workspaceB = createTestServices()
  const b = new CodexAppServerTransport(workspaceB, codexOptions(w.state))
  try {
    const broker = createSessionBroker(w.context.owner, { sessionId: "s3", workspaceId: "w2", directory: w.state.directory, origin })
    w.context.ports.current.set("s3", { ...authority, sessionId: "s3", workspaceId: "w2", directory: w.state.directory })
    w.context.ports.directories.set("s3", w.state.directory)
    const session = await b.start({ ...w.context.start, sessionId: "s3", workspaceId: "w2", credentials: binding(w.state, "w2", "account-one") }, broker)
    const turnBroker = createTurnBroker(w.context.owner, { authority: w.context.ports.current.get("s3")!, origin, signal: new AbortController().signal })
    expect(await text(b.send(session, { ...w.context.turn(marked("WORKSPACEB")), turnId: "w2-turn" }, turnBroker))).toContain("WORKSPACEB")
    expect(authorizations(w.state, "WORKSPACEB")).toEqual(["Bearer placeholder-w2"])
    expect(w.processes()).toHaveLength(1)
    expect(workspaceB.processes).toHaveLength(1)
    expect(workspaceB.processes[0]!.pid).not.toBe(w.processes()[0]!.pid)
    await b.dispose()
    expect(await workspaceB.processes[0]!.exited).toBeDefined()
    expect(await first(w, "AFTERDISPOSE")).toContain("AFTERDISPOSE")
    expect(await aliveAfter(w.processes()[0]!, 300)).toBe("alive")
  } finally { await b.dispose(); await w.close() }
}, 180_000)

test("an account change moves only that session to a new app-server while its sibling's turn completes on the shared one", async () => {
  const w = await sharedWorkspace("codex-share-move", ["account-one", "account-one"])
  try {
    expect(await first(w, "BEFOREMOVE")).toContain("BEFOREMOVE")
    const release = w.state.server.holdTextReplies("SIBLINGHELD")
    const sibling = other(w, "SIBLINGHELD")
    await w.state.server.textGateReached("SIBLINGHELD")
    expect(await w.context.transport.configure(w.context.session, { credentials: binding(w.state, "w1", "account-two") })).toEqual({ state: "applied" })
    expect(w.processes()).toHaveLength(2)
    release()
    expect(await sibling).toContain("SIBLINGHELD")
    const moved = await first(w, "AFTERMOVE")
    expect(moved).toContain("AFTERMOVE")
    expect(w.state.server.requests.find((request) => request.prompt.includes("AFTERMOVE"))?.prompt).toContain("BEFOREMOVE")
    expect(await aliveAfter(w.processes()[0]!, 300)).toBe("alive")
  } finally { await w.close() }
}, 180_000)

test("a session lost to a turn/start timeout archives its thread on the live app-server, so it resumes on another one", async () => {
  const expire = { armed: false }
  const w = await sharedWorkspace("codex-share-lost", ["account-one", "account-one"], { prepare: (services) => {
    const clock = services.clock
    services.clock = { ...clock, setTimeout: (callback, ms) => {
      if (!expire.armed || ms !== 60_000) return clock.setTimeout(callback, ms)
      expire.armed = false
      queueMicrotask(callback)
      return undefined
    } }
  } })
  try {
    expect(await first(w, "BEFORELOST")).toContain("BEFORELOST")
    expire.armed = true
    await expect(first(w, "TIMEDOUT")).rejects.toThrow("turn/start")
    expect(w.context.transport.health!.runtime(w.state.directory, "s1")).toMatchObject({ status: "degraded" })
    expect(await w.context.transport.configure(w.context.session, { credentials: binding(w.state, "w1", "account-two") })).toEqual({ state: "applied" })
    const resumed = await first(w, "AFTERLOST")
    expect(resumed).toContain("AFTERLOST")
    expect(w.state.server.requests.find((request) => request.prompt.includes("AFTERLOST"))?.prompt).toContain("BEFORELOST")
    expect(w.processes()).toHaveLength(2)
    expect(await other(w, "SIBLINGKEPT")).toContain("SIBLINGKEPT")
    expect(w.context.transport.health!.runtime(w.state.directory, "s1")).toEqual({ status: "ok" })
  } finally { await w.close() }
}, 180_000)

test("the first starts of two accounts of one owner on a fresh store both initialize", async () => {
  const state = await codexBackend()
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, codexOptions(state))
  const broker = (sessionId: string) => ({ rebind: async (upstreamSessionId: string) => ({ sessionId, workspaceId: "w1", directory: state.directory,
    connectionId: "codex-app-server", upstreamSessionId }), goal: { read: () => null, publish: async () => {} }, reportFailure: () => {}, publish: async () => {} }) as unknown as SessionBroker
  const input = (sessionId: string, credentialId: string) => ({ sessionId, workspaceId: "w1", directory: state.directory, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: binding(state, "w1", credentialId),
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } })
  try {
    const sessions = await Promise.all([transport.start(input("s1", "account-one"), broker("s1")), transport.start(input("s2", "account-two"), broker("s2"))])
    expect(sessions.map((session) => session.binding.upstreamSessionId).every(Boolean)).toBe(true)
    expect(services.processes).toHaveLength(2)
  } finally { await transport.dispose(); await state.close() }
}, 180_000)

test("a stray frame and 300 early frames for threads no session owns fail no session on the shared app-server", async () => {
  let inject: (line: string) => void = () => { throw new Error("Codex was not spawned") }
  const w = await sharedWorkspace("codex-share-stray", ["account-one", "account-one"], { prepare: (services) => {
    const spawn = services.spawn.bind(services)
    services.spawn = async (command, options) => {
      const owned = await spawn(command, options)
      const stdout = new PassThrough()
      owned.stdout.pipe(stdout)
      inject = (line) => { stdout.write(`${line}\n`) }
      return { ...owned, stdout }
    }
  } })
  try {
    expect(await first(w, "STRAYBEFORE")).toContain("STRAYBEFORE")
    inject(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "stray-thread", turnId: "stray", itemId: "stray", delta: "STRAY" } }))
    for (let index = 0; index < 300; index++) inject(JSON.stringify({ method: "turn/started", params: { threadId: `early-${index}`, turn: { id: "early" } } }))
    const [a, b] = await Promise.all([first(w, "STRAYAFTERA"), other(w, "STRAYAFTERB")])
    expect(a).toContain("STRAYAFTERA")
    expect(b).toContain("STRAYAFTERB")
    expect(a).not.toContain("STRAY ")
    expect(w.context.transport.health!.runtime(w.state.directory, "s1")).toEqual({ status: "ok" })
    expect(w.context.transport.health!.runtime(w.state.directory, "s2")).toEqual({ status: "ok" })
    expect(w.processes()).toHaveLength(1)
  } finally { await w.close() }
}, 180_000)

test("the shared app-server outlives its last session for the idle window and is then retired", async () => {
  const w = await sharedWorkspace("codex-share-idle", ["account-one", "account-one"], { idleMs: 1_000 })
  try {
    expect(await first(w, "IDLEA")).toContain("IDLEA")
    await w.context.transport.close(w.context.session)
    await w.context.transport.close(w.second)
    const process = w.processes()[0]!
    expect(await aliveAfter(process, 300)).toBe("alive")
    expect(await aliveAfter(process, 5_000)).toBe("exited")
  } finally { await w.close() }
}, 180_000)
