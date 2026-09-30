import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { runConformance, setupConformance, type ConformanceBackend, withUndeliverableFile, type SuiteBackend } from "./test-support/run"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedCursorBackend } from "../../e2e/harness/cursor/backend"
import { egressProxyEnv, startEgressGuard, unexpectedEgress } from "../../e2e/harness/egress-guard"
import { startScriptedMcpServer } from "../../e2e/harness/scripted-mcp-server"
import { createHash } from "node:crypto"
import { PassThrough } from "node:stream"
import { CursorSdkTransport, type CursorSdkTransportOptions } from "../transports/cursor-sdk"
import { CursorHost, CursorHostRegistry, cursorHostEnvironment } from "../transports/cursor-sdk/host-registry"
import { createTestServices } from "./test-support/services"
import { pollUntil } from "./test-support/poll"
import type { RoutedEvent, SessionBroker, TurnInput } from "../contract"

const CURSOR_WORKER = { file: process.execPath, args: [path.join(import.meta.dirname, "../transports/cursor-sdk/host.ts")] }

type CursorBackend = SuiteBackend & { root: string; env: NodeJS.ProcessEnv; server: Awaited<ReturnType<typeof startScriptedCursorBackend>> }

type Context = Awaited<ReturnType<typeof setupConformance>>

async function backend(): Promise<CursorBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-conformance-"))
  const directory = path.join(root, "work")
  const home = path.join(root, "person")
  await fs.mkdir(directory)
  await fs.mkdir(home)
  const serverPort = await reservePort()
  const guardPort = await reservePort()
  const server = await startScriptedCursorBackend(serverPort)
  const guard = await startEgressGuard(guardPort)
  server.script("conformance", { steps: [{ kind: "text", text: "PICONFORM" }], usage: { inputTokens: 7, outputTokens: 11 } })
  server.defaultScript("conformance")
  return {
    execution: "process", root, directory, server, env: { ...process.env, HOME: home, USERPROFILE: home, ...egressProxyEnv(guard.url) },
    harness: { id: "cursor", access: "native" }, model: { providerID: "cursor", modelID: "scripted" },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: { cursor: { baseUrl: server.url, placeholder: "cursor-conformance-placeholder", authMode: "bearer" } },
      secrets: {}, leaseGeneration: "conformance" },
    owner: { kind: "machine-owner" }, expectedMcp: "session", textCommand: "CURSOR_SCRIPT:conformance",
    scriptThinking: ({ marker, text, reasoning }) => {
      server.script(marker, { steps: [{ kind: "thinking", text: reasoning, durationMs: 1200 }, { kind: "text", text }] })
      server.defaultScript(marker)
    },
    unrunnableTurn: withUndeliverableFile,
    hold: (marker) => server.holdText(marker),
    held: (marker) => server.textHeld(marker),
    steerIncorporationUnreported: true,
    credentialsPerCommand: true,
    close: async () => {
      console.log(`Cursor outbound attempts: ${JSON.stringify(guard.attempts)}`)
      const unexpected = unexpectedEgress(guard.attempts)
      await guard.close()
      await server.close()
      releasePort(serverPort)
      releasePort(guardPort)
      await fs.rm(root, { recursive: true, force: true })
      expect(unexpected).toEqual([])
    },
  }
}

function homeRoot(state: CursorBackend) {
  return path.join(state.root, "cursor-homes")
}

const LOGIN = { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true } as const

function transportFor(state: CursorBackend, env: NodeJS.ProcessEnv = state.env, login: Partial<CursorSdkTransportOptions> = {}) {
  return (services: ConstructorParameters<typeof CursorSdkTransport>[0]) =>
    new CursorSdkTransport(services, { homeRoot: homeRoot(state), worker: CURSOR_WORKER, env, ...LOGIN, ...login })
}

async function claxedoHomes(state: CursorBackend): Promise<string[]> {
  const entries = await fs.readdir(homeRoot(state), { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(homeRoot(state), entry.name))
}

async function hashTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const walk = async (folder: string) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const pathname = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(pathname)
      else result[path.relative(root, pathname)] = createHash("sha256").update(await fs.readFile(pathname)).digest("hex")
    }
  }
  await walk(root)
  return result
}

function personalCursorDir(state: CursorBackend) {
  return path.join(state.env.HOME!, ".cursor")
}

async function collect(context: Context, turn: TurnInput, session = context.session): Promise<RoutedEvent[]> {
  const events: RoutedEvent[] = []
  for await (const event of context.transport.send(session, turn, context.turnBroker())) events.push(event)
  return events
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "", (error: unknown) => String(error))
}

function runText(state: CursorBackend, index = -1): string {
  return JSON.stringify(state.server.runs.at(index)?.run ?? null)
}

function draftOf(context: Context) {
  const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
  return draft
}

runConformance({
  name: "cursor-sdk",
  backend,
  makeTransport(services, state) { return transportFor(state as CursorBackend)(services) },
})

test("keeps the machine owner's endpoint when no binding is selected and points the host at its home", () => {
  const env = cursorHostEnvironment({ CURSOR_BACKEND_URL: "http://127.0.0.1:49177", CURSOR_API_KEY: "owner-key", CURSOR_DATA_DIR: "/elsewhere" }, "/claxedo/home")
  expect(env.CURSOR_BACKEND_URL).toBe("http://127.0.0.1:49177")
  expect(env.CURSOR_API_KEY).toBe("owner-key")
  expect(env.HOME).toBe("/claxedo/home")
  expect(env.CURSOR_DATA_DIR).toBeUndefined()
  const brokered = cursorHostEnvironment(env, "/claxedo/home", "http://127.0.0.1:49178/bindings/cursor")
  expect(brokered.CURSOR_BACKEND_URL).toBe("http://127.0.0.1:49178/bindings/cursor")
  expect(brokered.CURSOR_API_KEY).toBeUndefined()
})

test("an unbound worker sends the SDK turn to the machine owner's endpoint", async () => {
  const state = await backend()
  const unbound = { ...state, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "owner" } }
  const context = await setupConformance({ name: "machine-owner", backend: async () => unbound,
    makeTransport: transportFor(state, { ...state.env, CURSOR_BACKEND_URL: state.server.url, CURSOR_API_KEY: "owner-placeholder" }) })
  try {
    const events = await collect(context, context.turn("CURSOR_SCRIPT:conformance"))
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    expect(state.server.requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE")).toBe(true)
  } finally { await context.close() }
})

test.each([
  ["another person at loopback", { kind: "person", userId: "member" } as const, {}],
  ["the machine owner on a self-hosted server", { kind: "machine-owner" } as const, { placement: "self-hosted" as const }],
  ["the machine owner in the cloud", { kind: "machine-owner" } as const, { placement: "cloud" as const }],
  ["the machine owner when own logins are disabled", { kind: "machine-owner" } as const, { canUseOwnLogin: false }],
])("an unbound session of %s cannot use the machine Cursor key", async (_label, owner, login) => {
  const state = await backend()
  await expect(setupConformance({ name: "unbound", backend: async () => ({ ...state, owner,
    credentials: { machineLoginAllowed: false, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "unbound" } }),
    makeTransport: transportFor(state, { ...state.env, CURSOR_BACKEND_URL: state.server.url, CURSOR_API_KEY: "owner-placeholder" }, login) }))
    .rejects.toThrow("Cursor SDK requires an API key")
})

test("a person who is the machine owner uses the machine Cursor key at the desktop", async () => {
  const state = await backend()
  const unbound = { ...state, owner: { kind: "person", userId: "owner" } as const, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "owner" } }
  const context = await setupConformance({ name: "owner-person", backend: async () => unbound,
    makeTransport: transportFor(state, { ...state.env, CURSOR_BACKEND_URL: state.server.url, CURSOR_API_KEY: "owner-placeholder" }, { placement: "desktop" }) })
  try {
    expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((event) => event.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("a failed run leaves another session on the shared host running", async () => {
  const state = await backend()
  state.server.script("held", { steps: [{ kind: "text", text: "HELD-FINISHED" }], hold: true })
  state.server.script("failed", { steps: [], error: { status: 503, message: "scripted failure" } })
  const context = await setupConformance({ name: "shared", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const second = await context.transport.start({ ...context.start, sessionId: "s2" },
      { rebind: async (upstreamSessionId: string) => ({ ...context.session.binding, sessionId: "s2", upstreamSessionId }) } as unknown as SessionBroker)
    const held = collect(context, context.turn("CURSOR_SCRIPT:held"), second).then((events) => ({ events }), (error: unknown) => ({ error }))
    await pollUntil(() => state.server.requests.some((request) => request.path === "/aiserver.v1.BidiService/BidiAppend"
      && JSON.stringify(request.decoded).includes("CURSOR_SCRIPT:held")) || undefined, Date.now() + 10_000)
    const failedEvents = []
    let rejected = false
    try {
      for await (const event of context.transport.send(context.session, context.turn("CURSOR_SCRIPT:failed"), context.turnBroker())) failedEvents.push(event)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      rejected = true
    }
    expect(rejected || failedEvents.some((event) => event.event.type === "error")).toBe(true)
    state.server.release("held")
    const outcome = await held
    if ("error" in outcome) throw outcome.error
    expect(outcome.events.some((event) => event.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 90_000)

test("a silent run expires by inactivity, is cancelled alone, and the shared host keeps serving", async () => {
  const state = await backend()
  state.server.script("held", { steps: [], hold: true })
  const services = createTestServices()
  const registry = new CursorHostRegistry(services, CURSOR_WORKER, state.env, new AbortController().signal)
  const home = path.join(state.root, "deadline-home")
  await fs.mkdir(home, { recursive: true })
  const session = { sessionId: "deadline", directory: state.directory, apiKey: "cursor-conformance-placeholder", model: "scripted",
    mcpServers: {}, local: { sandboxOptions: { enabled: false } } }
  try {
    const host = await registry.acquire({ binding: "deadline", home, backendUrl: state.server.url })
    await host.call({ kind: "open", session })
    const running = host.call({ kind: "run", session, prompt: "CURSOR_SCRIPT:held" }, undefined,
      { at: Date.now() + 300, signal: new AbortController().signal })
    const other = host.call({ kind: "run", session: { ...session, sessionId: "deadline-2" }, prompt: "CURSOR_SCRIPT:held" })
    const outcome = await running.then(() => "answered", (error: unknown) => String(error))
    expect(outcome).toMatch(/Cursor run exceeded its inactivity deadline/)
    expect(host.failed).toBe(false)
    state.server.release("held")
    const survived = await other
    expect(survived.kind === "result" && survived.value?.status).toBe("finished")
    expect(services.processes).toHaveLength(1)
    expect(await Promise.race([services.processes[0]!.exited.then(() => "exited"), new Promise((resolve) => setTimeout(() => resolve("alive"), 300))])).toBe("alive")
  } finally { await registry.dispose(); await state.close() }
}, 30_000)

test("a run that keeps streaming outlives its inactivity window", async () => {
  const state = await backend()
  state.server.script("slow", { steps: [
    { kind: "text", text: "ONE" }, { kind: "wait", ms: 600 }, { kind: "text", text: "TWO" }, { kind: "wait", ms: 600 },
    { kind: "text", text: "THREE" }, { kind: "wait", ms: 600 }, { kind: "text", text: "FOUR" },
  ] })
  const services = createTestServices()
  const registry = new CursorHostRegistry(services, CURSOR_WORKER, state.env, new AbortController().signal)
  const home = path.join(state.root, "slow-home")
  await fs.mkdir(home, { recursive: true })
  const session = { sessionId: "slow", directory: state.directory, apiKey: "cursor-conformance-placeholder", model: "scripted",
    mcpServers: {}, local: { sandboxOptions: { enabled: false } } }
  try {
    const host = await registry.acquire({ binding: "slow", home, backendUrl: state.server.url })
    await host.call({ kind: "open", session })
    const events: string[] = []
    const reply = await host.call({ kind: "run", session, prompt: "CURSOR_SCRIPT:slow" }, (event) => { if (event.kind === "event") events.push(event.message.type) },
      { at: Date.now() + 1_500, signal: new AbortController().signal })
    expect(reply.kind === "result" && reply.value?.status).toBe("finished")
    expect(reply.kind === "result" ? reply.value?.result : undefined).toBe("ONETWOTHREEFOUR")
    expect(events.filter((type) => type === "assistant").length).toBeGreaterThanOrEqual(2)
  } finally { await registry.dispose(); await state.close() }
}, 30_000)

test("a host that stops answering a cancel is retired", async () => {
  const services = createTestServices()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let retired = false
  let exit!: (status: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve })
  const host = new CursorHost({ pid: 4_194_305, stdin, stdout, stderr, exited,
    retire: async () => { retired = true; exit({ code: null, signal: "SIGTERM" }); return { stopped: true } } }, services.clock, services.log)
  const cancelled = host.call({ kind: "cancel", sessionId: "s" }, undefined, { at: Date.now() + 200, signal: new AbortController().signal })
  await expect(cancelled).rejects.toThrow("Cursor cancel exceeded its deadline")
  await pollUntil(() => retired || undefined, Date.now() + 2_000)
  expect(retired).toBe(true)
  expect(host.failed).toBe(true)
  await expect(host.call({ kind: "close", sessionId: "s" })).rejects.toThrow("Cursor SDK host retired")
})

test("a credential update on one session reaches its next turn on the host it shares with another session", async () => {
  const state = await backend()
  const context = await setupConformance({ name: "shared-rotation", backend: async () => state, makeTransport: transportFor(state) })
  try {
    await collect(context, context.turn("CURSOR_SCRIPT:conformance"))
    const processes = context.services.processes.length
    const { credentials } = context.backend
    const rotated = { ...credentials, leaseGeneration: "rotated", providers: { cursor: { ...credentials.providers.cursor!, placeholder: "cursor-rotated-placeholder" } } }
    expect(await context.transport.configure(context.session, { credentials: rotated })).toEqual({ state: "applied" })
    expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((item) => item.event.type === "finish")).toBe(true)
    expect(context.services.processes).toHaveLength(processes)
    expect(state.server.requests.some((request) => request.path === "/auth/exchange_user_api_key"
      && request.headers.authorization === "Bearer cursor-rotated-placeholder")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("two bindings use separate SDK hosts", async () => {
  const first = await backend()
  const second = await backend()
  const services = createTestServices()
  const transport = transportFor(first)(services)
  try {
    const one = await setupConformance({ name: "first", backend: async () => first, makeTransport: () => transport })
    const secondSession = await transport.start({ ...one.start, sessionId: "s2", workspaceId: "w2",
      directory: second.directory, credentials: second.credentials }, { rebind: async (upstreamSessionId: string) =>
        ({ sessionId: "s2", workspaceId: "w2", directory: second.directory, connectionId: "cursor-sdk", upstreamSessionId }) } as unknown as SessionBroker)
    const [firstEvents, secondEvents] = await Promise.all([
      collect(one, one.turn("CURSOR_SCRIPT:conformance")), collect(one, one.turn("CURSOR_SCRIPT:conformance"), secondSession)])
    expect(firstEvents.some((item) => item.event.type === "finish")).toBe(true)
    expect(secondEvents.some((item) => item.event.type === "finish")).toBe(true)
    expect(first.server.requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE")).toBe(true)
    expect(second.server.requests.some((request) => request.path === "/agent.v1.AgentService/RunSSE")).toBe(true)
    expect(services.processes).toHaveLength(2)
  } finally { await transport.dispose(); await first.close(); await second.close() }
}, 60_000)

test.each([
  ["/auth/exchange_user_api_key", true],
  ["/aiserver.v1.DashboardService/GetUserPrivacyMode", false],
  ["/aiserver.v1.ServerConfigService/GetServerConfig", false],
  ["/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam", false],
  ["/aiserver.v1.AnalyticsService/BootstrapStatsig", false],
  ["/agent.v1.AgentService/RunSSE", true],
] as const)("records whether refusing %s stops a turn", async (path, shouldFail) => {
  const denied = await backend()
  denied.server.refusePath(path, 403)
  let failed = false
  try {
    const context = await setupConformance({ name: "denied", backend: async () => denied, makeTransport: transportFor(denied) })
    try {
      const events = await collect(context, context.turn("CURSOR_SCRIPT:conformance"))
      failed = events.some((event) => event.event.type === "error") || !events.some((event) => event.event.type === "finish")
    } catch { failed = true }
    await context.close()
  } catch { failed = true }
  expect(denied.server.requests.some((request) => request.path === path)).toBe(true)
  expect(failed).toBe(shouldFail)

  const allowed = await backend()
  const context = await setupConformance({ name: "allowed", backend: async () => allowed, makeTransport: transportFor(allowed) })
  try {
    const events = await collect(context, context.turn("CURSOR_SCRIPT:conformance"))
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    expect(allowed.server.requests.some((request) => request.path === path)).toBe(true)
  } finally { await context.close() }
}, 90_000)

test("a host that dies mid-run fails that turn as retryable, and the next turn resumes the agent on a new host", async () => {
  const state = await backend()
  state.server.script("dies", { steps: [{ kind: "text", text: "BEFORE-DEATH" }], hold: true })
  const context = await setupConformance({ name: "host-death", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const upstream = context.session.binding.upstreamSessionId
    const turn = collect(context, context.turn("CURSOR_SCRIPT:dies")).then(() => undefined, (error: unknown) => error)
    await pollUntil(() => state.server.requests.some((request) => request.path === "/aiserver.v1.BidiService/BidiAppend"
      && JSON.stringify(request.decoded).includes("CURSOR_SCRIPT:dies")) || undefined, Date.now() + 15_000)
    const host = context.services.processes.at(-1)!
    process.kill(host.pid, "SIGKILL")
    expect(await turn).toMatchObject({ transport: "cursor", code: "worker", retryable: true })
    const recovered = await collect(context, context.turn("CURSOR_SCRIPT:conformance"))
    expect(recovered.some((item) => item.event.type === "finish")).toBe(true)
    expect(context.services.processes.at(-1)).not.toBe(host)
    expect(context.session.binding.upstreamSessionId).toBe(upstream)
  } finally { await context.close() }
}, 60_000)

test("a failed scripted run leaves the next turn usable", async () => {
  const state = await backend()
  state.server.script("crash", { steps: [], error: { status: 503, message: "scripted Cursor failure" } })
  const context = await setupConformance({ name: "recovery", backend: async () => state, makeTransport: transportFor(state) })
  try {
    let failed = false
    try {
      const events = await collect(context, context.turn("CURSOR_SCRIPT:crash"))
      failed = events.some((event) => event.event.type === "error") || !events.some((event) => event.event.type === "finish")
    } catch { failed = true }
    expect(failed).toBe(true)
    const recovered = await collect(context, context.turn("CURSOR_SCRIPT:conformance"))
    expect(recovered.some((event) => event.event.type === "finish")).toBe(true)
    expect(state.server.requests.filter((request) => request.path === "/agent.v1.AgentService/RunSSE").length).toBeGreaterThan(1)
  } finally { await context.close() }
}, 90_000)

test("repeated text chunks, every turn end's usage and a compaction summary reach the turn through the real SDK", async () => {
  const state = await backend()
  const update = (value: Record<string, unknown>) => ({ kind: "update" as const, update: value })
  state.server.script("chunks", { steps: [
    update({ textDelta: { text: "Hel" } }), update({ textDelta: { text: "lo" } }), update({ textDelta: { text: "lo" } }),
    update({ summary: { summary: "Earlier turns, summarized" } }),
    update({ turnEnded: { inputTokens: "100", outputTokens: "20", cacheReadTokens: "30", cacheWriteTokens: "4", reasoningTokens: "6" } }),
  ], usage: { inputTokens: 7, outputTokens: 11 } })
  const context = await setupConformance({ name: "chunks", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const events = (await collect(context, context.turn("CURSOR_SCRIPT:chunks"))).map((item) => item.event)
    expect(events.flatMap((event) => event.type === "text-delta" ? [event.delta] : []).join("")).toBe("Hellolo")
    expect(events.filter((event) => event.type === "session-compaction")).toMatchObject([{ phase: "completed", summary: "Earlier turns, summarized" }])
    expect(events.filter((event) => event.type === "usage").at(-1)).toMatchObject({ contextSize: 0,
      observation: { kind: "cumulative", tokens: { input: 107, output: 31, reasoning: 6, cache: { read: 30, write: 4 } } } })
  } finally { await context.close() }
}, 60_000)

test("a stop interrupts the SDK run, the turn ends cancelled, and the stop reports the run terminal", async () => {
  const state = await backend()
  state.server.script("stoppable", { steps: [{ kind: "text", text: "STOPPABLE-PARTIAL" }, { kind: "wait", ms: 20_000 }, { kind: "text", text: "NEVER" }] })
  const context = await setupConformance({ name: "stop", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const turn = context.turn("CURSOR_SCRIPT:stoppable")
    const events: RoutedEvent[] = []
    const draining = (async () => { for await (const event of context.transport.send(context.session, turn, context.turnBroker())) events.push(event) })()
    await pollUntil(() => events.some((item) => item.event.type === "text-delta") || undefined, Date.now() + 15_000)
    const outcome = await context.transport.cancel(context.session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId },
      { at: Date.now() + 15_000, signal: new AbortController().signal })
    await draining
    expect(outcome).toEqual({ execution: "terminal", cleanup: "unknown" })
    expect(events.filter((item) => ["finish", "cancelled", "error"].includes(item.event.type)).map((item) => item.event.type)).toEqual(["cancelled"])
  } finally { await context.close() }
}, 60_000)

test("a steer reaches the running Cursor turn, a steer Cursor turns back is declined, and neither is written into the reply", async () => {
  const state = await backend()
  state.server.script("steered", { steps: [{ kind: "text", text: "STEERED-DONE" }] })
  state.server.script("refusing", { steps: [{ kind: "text", text: "REFUSED-DONE" }], steer: "rejected" })
  const context = await setupConformance({ name: "steer", backend: async () => state, makeTransport: transportFor(state) })
  try {
    for (const [name, expected] of [["steered", { ok: true }], ["refusing", { ok: false, status: "declined" }]] as const) {
      const release = state.server.holdText(`CURSOR_SCRIPT:${name}`)
      const turn = context.turn(`CURSOR_SCRIPT:${name}`)
      const running = collect(context, turn)
      await state.server.textHeld(`CURSOR_SCRIPT:${name}`)
      const result = await pollUntil(async () => {
        const answer = await context.transport.steer?.steer(context.session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId },
          context.turn(`Also mention STEER-${name}`, `msg_${name}`))
        return answer && !answer.ok && answer.status === "no_active_turn" ? undefined : answer
      }, Date.now() + 10_000)
      expect(result).toMatchObject(expected)
      release()
      const events = (await running).map((item) => item.event)
      expect(events.some((event) => event.type === "finish")).toBe(true)
      expect(events.some((event) => event.type === "input-incorporated")).toBe(false)
    }
    expect(state.server.steers.map((steer) => steer.text)).toEqual([expect.stringContaining("STEER-steered"), expect.stringContaining("STEER-refusing")])
  } finally { await context.close() }
}, 60_000)

test("offers Cursor's permission modes and refuses an unknown one", async () => {
  const state = await backend()
  const context = await setupConformance({ name: "modes", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const modes = await context.transport.config?.permissionModes({ session: context.session })
    expect(modes?.modes.map((mode) => mode.id)).toEqual(["review", "auto-review", "unsandboxed"])
    expect(modes?.modes.map((mode) => mode.level)).toEqual(["ask", "auto", "full"])
    expect(modes).toEqual({ modes: modes!.modes, appliesFrom: "next-turn" })
    expect(await context.transport.config?.permissionModes({ draft: draftOf(context) })).toEqual({ modes: modes!.modes, appliesFrom: "next-turn" })
    await expect(context.transport.config!.setPermissionMode(context.session, "yolo")).rejects.toThrow("Unknown Cursor permission mode yolo")
    expect((await context.transport.config!.read(context.session)).permissionMode).toBeUndefined()
    expect((await context.transport.config!.setPermissionMode(context.session, "unsandboxed")).currentModeId).toBe("unsandboxed")
    expect((await context.transport.config!.read(context.session)).permissionMode).toBe("unsandboxed")
  } finally { await context.close() }
}, 60_000)

test.each(["review", "auto-review"])("selecting %s reaches the SDK's sandbox gate on the next turn and can be undone", async (modeId) => {
  const state = await backend()
  const context = await setupConformance({ name: `mode-${modeId}`, backend: async () => state, makeTransport: transportFor(state) })
  try {
    expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((event) => event.event.type === "finish")).toBe(true)
    expect((await context.transport.config!.setPermissionMode(context.session, modeId)).currentModeId).toBe(modeId)
    expect(await refusal(collect(context, context.turn("CURSOR_SCRIPT:conformance")))).toMatch(/sandboxing is not supported in this environment/)
    expect(state.server.requests.filter((request) => request.path === "/agent.v1.AgentService/RunSSE")).toHaveLength(1)
    expect((await context.transport.config!.setPermissionMode(context.session, "unsandboxed")).currentModeId).toBe("unsandboxed")
    expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((event) => event.event.type === "finish")).toBe(true)
    expect(state.server.requests.filter((request) => request.path === "/agent.v1.AgentService/RunSSE")).toHaveLength(2)
  } finally { await context.close() }
}, 60_000)

test("a session created in review mode is refused by the SDK's sandbox gate on its first turn", async () => {
  const state = await backend()
  const context = await setupConformance({ name: "review-start", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const review = await context.transport.start({ ...context.start, sessionId: "s2", config: { ...context.start.config, permissionMode: "review" } },
      { rebind: async (upstreamSessionId: string) => ({ ...context.session.binding, sessionId: "s2", upstreamSessionId }) } as unknown as SessionBroker)
    expect((await context.transport.config!.permissionModes({ session: review })).currentModeId).toBe("review")
    const refused = await collect(context, context.turn("CURSOR_SCRIPT:conformance"), review).then(() => undefined, (error: unknown) => error)
    expect(String(refused)).toMatch(/sandboxing is not supported in this environment/)
    expect(refused).toMatchObject({ transport: "cursor", code: "sdk", retryable: false, detail: { sdkError: "ConfigurationError" } })
    expect(state.server.requests.filter((request) => request.path === "/agent.v1.AgentService/RunSSE")).toHaveLength(0)
    expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("a mode chosen before the session's first turn is the one that turn runs under", async () => {
  const state = await backend()
  const context = await setupConformance({ name: "mode-before-first-turn", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const { permissionMode: _chosen, ...unchosen } = context.start.config
    let binding = { ...context.session.binding, sessionId: "s2" }
    const session = await context.transport.start({ ...context.start, sessionId: "s2", config: unchosen },
      { rebind: async (upstreamSessionId: string) => (binding = { ...binding, upstreamSessionId }) } as unknown as SessionBroker)
    expect((await context.transport.config!.setPermissionMode(session, "unsandboxed")).currentModeId).toBe("unsandboxed")
    const events = await collect(context, context.turn("CURSOR_SCRIPT:conformance"), { ...session, binding })
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    expect(binding.upstreamSessionId).not.toBe(session.binding.upstreamSessionId)
  } finally { await context.close() }
}, 60_000)

test("a scripted todo update reaches the stream as todo-update", async () => {
  const state = await backend()
  const todos = [{ id: "one", content: "Write tests", status: "TODO_STATUS_IN_PROGRESS" }, { id: "two", content: "Ship", status: "TODO_STATUS_PENDING" }]
  state.server.script("todo", { steps: [
    { kind: "tool", tool: "updateTodosToolCall", args: { todos }, result: { success: { todos, totalCount: 2 } } },
    { kind: "text", text: "TODO-DONE" },
  ] })
  const context = await setupConformance({ name: "todo", backend: async () => state, makeTransport: transportFor(state) })
  try {
    expect((await context.transport.capabilities({ directory: state.directory })).todos).toBe(true)
    const events = await collect(context, context.turn("CURSOR_SCRIPT:todo"))
    const updates = events.flatMap((item) => item.event.type === "todo-update" ? [item.event.todos] : [])
    expect(updates[0]).toEqual([
      { id: "0", description: "Write tests", status: "in_progress" },
      { id: "1", description: "Ship", status: "pending" },
    ])
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("generateTitle runs one side request on a throwaway agent in the session's worker", async () => {
  const state = await backend()
  state.server.script("title", { steps: [{ kind: "text", text: "Add leap-year tests" }] })
  const context = await setupConformance({ name: "title", backend: async () => state, makeTransport: transportFor(state) })
  try {
    expect((await context.transport.capabilities({ directory: state.directory })).titles).toBe("side-request")
    state.server.defaultScript("title")
    const request = { directory: state.directory, system: "Name it", user: "User: add leap-year tests", signal: new AbortController().signal }
    expect(await context.transport.naming?.generateTitle?.(context.session, request)).toBe("Add leap-year tests")
    const run = runText(state)
    expect(run).toContain("Name it\\n\\nUser: add leap-year tests")
    expect(run).not.toContain(context.session.binding.upstreamSessionId)
    state.server.defaultScript("conformance")
    expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((item) => item.event.type === "finish")).toBe(true)
    const aborted = new AbortController()
    aborted.abort()
    const before = state.server.runs.length
    expect(await context.transport.naming?.generateTitle?.(context.session, { ...request, signal: aborted.signal })).toBeNull()
    expect(state.server.runs).toHaveLength(before)
  } finally { await context.close() }
}, 60_000)

test("a turn's model reaches the SDK send on the next turn", async () => {
  const state = await backend()
  state.server.models([{ id: "scripted", displayName: "Scripted" }, { id: "second", displayName: "Second" }, { id: "auto", displayName: "Auto" }])
  const context = await setupConformance({ name: "turn-model", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const base = context.turn("CURSOR_SCRIPT:conformance")
    expect((await collect(context, { ...base, model: { providerID: "cursor", modelID: "second" } })).some((item) => item.event.type === "finish")).toBe(true)
    expect(runText(state)).toContain('"requestedModel":{"modelId":"second"}')
    expect((await collect(context, base)).some((item) => item.event.type === "finish")).toBe(true)
    expect(runText(state)).toContain('"requestedModel":{"modelId":"scripted"}')
  } finally { await context.close() }
}, 60_000)

test("config.options probes Cursor.models.list through the binding and pins auto ahead of the catalog", async () => {
  const state = await backend()
  state.server.models([{ id: "scripted", displayName: "Scripted", description: "Scripted model" }, { id: "second", displayName: "Second" }])
  const context = await setupConformance({ name: "models", backend: async () => state, makeTransport: transportFor(state) })
  try {
    expect(await context.transport.config?.options({ session: context.session }, "peek")).toEqual({ options: [] })
    const catalogReads = () => state.server.requests.filter((request) => request.path === "/v1/models").length
    const before = catalogReads()
    const preview = await context.transport.config!.options({ session: context.session }, "probe")
    const model = preview.options.find((option) => option.id === "model")
    expect(model?.selectOptions?.map((option) => option.id)).toEqual(["auto", "scripted", "second"])
    expect(model?.currentValue).toBe("scripted")
    expect(preview.resolvedModel).toEqual({ id: "scripted", name: "Scripted" })
    expect(catalogReads()).toBe(before + 1)
    expect(await context.transport.config?.options({ session: context.session }, "peek")).toEqual(preview)
    expect(await context.transport.config?.options({ session: context.session }, "probe")).toEqual(preview)
    expect((await context.transport.config!.options({ session: context.session, model: { providerID: "cursor", modelID: "second" } }, "peek")).resolvedModel)
      .toEqual({ id: "second", name: "Second" })
    expect(catalogReads()).toBe(before + 1)
    const capabilities = await context.transport.capabilities({ directory: state.directory, sessionId: context.session.binding.sessionId })
    expect(capabilities.modelSelection).toEqual({ status: "required", models: [
      { providerId: "cursor", modelId: "auto", name: "Auto" },
      { providerId: "cursor", modelId: "scripted", name: "Scripted", description: "Scripted model" },
      { providerId: "cursor", modelId: "second", name: "Second" },
    ] })
  } finally { await context.close() }
}, 60_000)

test("a Cursor goal runs /goal as a provider turn and settles from the run result", async () => {
  const state = await backend()
  state.server.script("goal", { steps: [{ kind: "text", text: "GOAL-DONE" }] })
  const context = await setupConformance({ name: "goal", backend: async () => state, makeTransport: transportFor(state) })
  const goal: { current: RuntimeGoalSnapshot | null } = { current: null }
  Object.assign(context.ports, { readGoal: () => goal.current, publishGoal: async (_sessionId: string, snapshot: RuntimeGoalSnapshot | null) => { goal.current = snapshot } })
  try {
    expect((await context.transport.capabilities({ directory: state.directory })).goals).toMatchObject({ implemented: true, available: true })
    const started = await context.transport.goals!.start(context.session, "CURSOR_SCRIPT:goal", context.sessionBroker)
    expect(started).toMatchObject({ ok: true, goal: { status: "active", objective: "CURSOR_SCRIPT:goal" } })
    await pollUntil(() => goal.current?.status === "complete" || undefined, Date.now() + 20_000)
    expect(goal.current).toMatchObject({ status: "complete", objective: "CURSOR_SCRIPT:goal" })
    expect(runText(state)).toContain("/goal CURSOR_SCRIPT:goal")
    expect(context.ports.drained.some((event) => JSON.stringify(event).includes("GOAL-DONE"))).toBe(true)
    expect(await context.transport.goals!.read(context.session)).toMatchObject({ status: "complete" })
    expect(await context.transport.goals!.delete(context.session)).toEqual({ ok: true, goal: null })
    expect(await context.transport.goals!.read(context.session)).toBeNull()
  } finally { await context.close() }
}, 60_000)

test("stopping a running Cursor goal interrupts the run and pauses the goal", async () => {
  const state = await backend()
  state.server.script("goal-held", { steps: [{ kind: "text", text: "HELD" }], hold: true })
  const context = await setupConformance({ name: "goal-stop", backend: async () => state, makeTransport: transportFor(state) })
  const goal: { current: RuntimeGoalSnapshot | null } = { current: null }
  Object.assign(context.ports, { readGoal: () => goal.current, publishGoal: async (_sessionId: string, snapshot: RuntimeGoalSnapshot | null) => { goal.current = snapshot } })
  try {
    expect((await context.transport.goals!.start(context.session, "CURSOR_SCRIPT:goal-held", context.sessionBroker)).ok).toBe(true)
    await pollUntil(() => state.server.runs.some((run) => JSON.stringify(run.run).includes("/goal CURSOR_SCRIPT:goal-held")) || undefined, Date.now() + 10_000)
    expect(await context.transport.goals!.stop(context.session)).toMatchObject({ ok: true, goal: { status: "paused" } })
    expect(goal.current?.status).toBe("paused")
    expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("a Task tool call is admitted through the broker with its transcript", async () => {
  const state = await backend()
  const args = { description: "Review auth", prompt: "Review the auth module", subagentType: { explore: {} } }
  state.server.script("task", { steps: [
    { kind: "tool", tool: "taskToolCall", args, result: { success: { agentId: "cursor-child-a", isBackground: false, durationMs: 50, transcriptPath: "/tmp/cursor-child-a.jsonl" } } },
    { kind: "text", text: "TASK-DONE" },
  ] })
  const context = await setupConformance({ name: "task", backend: async () => state, makeTransport: transportFor(state) })
  try {
    expect((await context.transport.capabilities({ directory: state.directory })).subagents).toBe(true)
    const events = await collect(context, context.turn("CURSOR_SCRIPT:task"))
    expect(context.ports.subagents.map((event) => ({ status: event.status, providerId: event.providerId, providerKind: event.providerKind,
      toolCallId: event.toolCallId, toolCallRole: event.toolCallRole }))).toEqual([
        { status: "running", providerId: undefined, providerKind: undefined, toolCallId: "scripted-tool-1", toolCallRole: "spawn" },
        { status: "completed", providerId: "cursor-child-a", providerKind: "cursor-agent", toolCallId: "scripted-tool-1", toolCallRole: "spawn" },
      ])
    expect(context.ports.subagents[1]?.childSessionId).toBeDefined()
    expect(context.services.transcriptRows.has("/tmp/cursor-child-a.jsonl")).toBe(true)
    expect(events.some((item) => item.event.type === "tool-output" && item.event.toolCallId === "scripted-tool-1")).toBe(true)
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("non-image attachments are materialized in the workspace and images travel inline", async () => {
  const state = await backend()
  const context = await setupConformance({ name: "attachments", backend: async () => state, makeTransport: transportFor(state) })
  try {
    const image = Buffer.from("png-bytes").toString("base64")
    const notes = Buffer.from("notes").toString("base64")
    const base = context.turn("CURSOR_SCRIPT:conformance")
    const turn: TurnInput = { ...base, prompt: { ...base.prompt, parts: [...base.prompt.parts,
      { type: "file", mime: "text/plain", filename: "notes.txt", url: `data:text/plain;base64,${notes}` },
      { type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${image}` },
    ] } }
    expect((await collect(context, turn)).some((item) => item.event.type === "finish")).toBe(true)
    const folder = path.join(state.directory, ".claxedo", "attachments")
    const files = (await fs.readdir(folder)).filter((name) => name !== ".gitignore")
    const written = files.find((name) => name.endsWith("-notes.txt"))
    expect(written).toBeDefined()
    expect(files.some((name) => name.endsWith("-shot.png"))).toBe(true)
    expect(await fs.readFile(path.join(folder, written!), "utf8")).toBe("notes")
    const run = runText(state)
    expect(run).toContain(`Attached file (text/plain): ${path.join(folder, written!)}`)
    expect(run).toContain(`"data":"${image}"`)
    expect(await refusal(collect(context, { ...base, prompt: { ...base.prompt, parts: [{ type: "file", mime: "text/plain", url: "https://example.invalid/notes.txt" }] } })))
      .toBe("CursorTransportError: Cursor cannot deliver the file URL https://example.invalid/notes.txt")
  } finally { await context.close() }
}, 60_000)

async function pluginRoot(state: CursorBackend, name: string, mcpUrl: string) {
  const root = path.join(state.root, name)
  await fs.mkdir(path.join(root, ".cursor-plugin"), { recursive: true })
  await fs.writeFile(path.join(root, ".cursor-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
  await fs.writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { proof: { type: "http", url: mcpUrl } } }))
  return root
}

async function managedPlugins(home: string) {
  return (await fs.readdir(path.join(home, ".cursor", "plugins", "local"))).filter((name) => name.startsWith("claxedo--"))
}

async function seedPersonalConfig(state: CursorBackend, personalMcpUrl: string) {
  const personal = personalCursorDir(state)
  await fs.mkdir(path.join(personal, "rules"), { recursive: true })
  await fs.mkdir(path.join(personal, "plugins", "local", "foreign", ".cursor-plugin"), { recursive: true })
  await fs.writeFile(path.join(personal, "mcp.json"), JSON.stringify({ mcpServers: { personal: { type: "http", url: personalMcpUrl } } }))
  await fs.writeFile(path.join(personal, "rules", "team.mdc"), "Always be kind.\n")
  await fs.writeFile(path.join(personal, "mcp-auth.json"), JSON.stringify({ personal: { token: "secret" } }))
  await fs.writeFile(path.join(personal, "plugins", "local", "foreign", ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "foreign", version: "1.0.0" }))
  return personal
}

test("a projected plugin reaches Cursor through a Claxedo home that mirrors the person's config and leaves it byte identical", async () => {
  const state = await backend()
  const pluginMcp = await startScriptedMcpServer()
  const personalMcp = await startScriptedMcpServer()
  try {
    const personal = await seedPersonalConfig(state, personalMcp.url)
    const before = await hashTree(personal)
    const root = await pluginRoot(state, "conform-plugin", pluginMcp.url)
    const projection = { generation: "g2", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "conform/plugin", root, skillNames: [], dataRoot: root }] }
    const closeUnchanged = async () => { expect(await hashTree(personal)).toEqual(before); await state.close() }
    const context = await setupConformance({ name: "plugin", backend: async () => ({ ...state, projection, close: closeUnchanged }), makeTransport: transportFor(state) })
    try {
      expect((await context.transport.capabilities({ directory: state.directory })).pluginIntake).toEqual({ mcp: "session", skills: "plugin-dir" })
      const [home] = await claxedoHomes(state)
      expect(home).toBeDefined()
      const installed = await managedPlugins(home!)
      expect(installed).toHaveLength(1)
      const local = path.join(home!, ".cursor", "plugins", "local")
      expect(JSON.parse(await fs.readFile(path.join(local, installed[0]!, ".claxedo-agent-plugin.json"), "utf8"))).toMatchObject({ pluginInstanceId: "conform/plugin" })
      expect(JSON.parse(await fs.readFile(path.join(local, installed[0]!, "mcp.json"), "utf8")).mcpServers.proof.url).toBe(pluginMcp.url)
      expect(JSON.parse(await fs.readFile(path.join(home!, ".cursor", "mcp.json"), "utf8")).mcpServers.personal.url).toBe(personalMcp.url)
      expect(await fs.readFile(path.join(home!, ".cursor", "rules", "team.mdc"), "utf8")).toBe("Always be kind.\n")
      expect(await fs.readdir(path.join(home!, ".cursor"))).not.toContain("mcp-auth.json")
      expect(await fs.readdir(local)).toContain("foreign")
      expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((item) => item.event.type === "finish")).toBe(true)
      await pollUntil(() => pluginMcp.methods.includes("initialize") && personalMcp.methods.includes("initialize") || undefined, Date.now() + 10_000)
      expect(pluginMcp.methods).toContain("initialize")
      expect(personalMcp.methods).toContain("initialize")
      expect(await fs.readdir(path.join(home!, ".cursor"))).toContain("projects")
      expect(await hashTree(personal)).toEqual(before)
      expect(await context.transport.configure(context.session, { projection: { ...projection, generation: "g3", pluginRoots: [] } })).toEqual({ state: "applied" })
      expect(await managedPlugins(home!)).toEqual([])
      expect(await fs.readdir(local)).toContain("foreign")
    } finally { await context.close() }
  } finally { await pluginMcp.close(); await personalMcp.close() }
}, 60_000)

test("a session without projected plugins mirrors the person's config without loading their plugin folder", async () => {
  const state = await backend()
  const personalMcp = await startScriptedMcpServer()
  const foreignMcp = await startScriptedMcpServer()
  try {
    const personal = await seedPersonalConfig(state, personalMcp.url)
    await fs.writeFile(path.join(personal, "plugins", "local", "foreign", "mcp.json"), JSON.stringify({ mcpServers: { proof: { type: "http", url: foreignMcp.url } } }))
    const before = await hashTree(personal)
    const context = await setupConformance({ name: "no-plugin", backend: async () => state, makeTransport: transportFor(state) })
    try {
      expect((await collect(context, context.turn("CURSOR_SCRIPT:conformance"))).some((item) => item.event.type === "finish")).toBe(true)
      await pollUntil(() => personalMcp.methods.includes("initialize") || undefined, Date.now() + 10_000)
      expect(personalMcp.methods).toContain("initialize")
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(foreignMcp.methods).toEqual([])
      const [home] = await claxedoHomes(state)
      expect(await managedPlugins(home!)).toEqual([])
      expect(await hashTree(personal)).toEqual(before)
    } finally { await context.close() }
  } finally { await personalMcp.close(); await foreignMcp.close() }
}, 60_000)

test("a plugin root whose link escapes it is refused before Cursor starts", async () => {
  const state = await backend()
  const root = path.join(state.root, "escaping")
  await fs.mkdir(path.join(root, ".cursor-plugin"), { recursive: true })
  await fs.writeFile(path.join(root, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "escaping", version: "1.0.0" }))
  await fs.symlink(state.directory, path.join(root, "outside"))
  const projection = { generation: "g2", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "escaping/plugin", root, skillNames: [], dataRoot: root }] }
  const escaping = { ...state, projection, close: async () => {} }
  await expect(setupConformance({ name: "escaping", backend: async () => escaping, makeTransport: transportFor(state) }))
    .rejects.toThrow("Cursor plugin link escapes its root")
  try {
    for (const home of await claxedoHomes(state)) {
      expect(await managedPlugins(home)).toEqual([])
      expect((await fs.readdir(path.join(home, ".cursor", "plugins", "local"))).filter((name) => name.startsWith(".claxedo"))).toEqual([])
    }
  } finally { await state.close() }
})
