import { scriptedClaude } from "../transports/claude-sdk/test-support/transport"
import { claudeTranslator } from "../transports/claude-sdk/events"
import { ClaudeMirroredUsage } from "../transports/claude-sdk/mirrored-usage"
import { createServer, type Server } from "node:http"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { runConformance, type ConformanceBackend, withUndeliverableFile } from "./test-support/run"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { PINNED_CLAUDE } from "../../e2e/harness/pinned-claude"
import { ClaudeSdkTransport } from "../transports/claude-sdk"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority, origin } from "./test-support/memory-ports"
import { createTestServices } from "./test-support/services"
import type { TestServices } from "./test-support/services"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { AbortError, type CanUseTool, type Query, type SDKMessage, type PermissionUpdate, type query } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessBinding, HarnessServices, SessionBroker, SpawnCommand, StartInput, RoutedEvent, TurnInput } from "../contract"
import { ClaudeGoals } from "../transports/claude-sdk/goals"
import { ClaudeQueryLauncher } from "../transports/claude-sdk/query-options"
import { askClaudePermission } from "../transports/claude-sdk/requests"
import { sdkModes } from "../transports/claude-sdk/permissions"
import { pollUntil } from "./test-support/poll"

type ClaudeBackend = ConformanceBackend & {
  root: string
  config: { harness: ConformanceBackend["harness"]; model: ConformanceBackend["model"]; permissionMode?: string }
  configRoot: string
  userConfigRoot: string
  env: NodeJS.ProcessEnv
  attempts: string[]
  sockets: string[]
  samples: Promise<void>[]
  sampledPids: number[]
  commands: SpawnCommand[]
  listener: Server
  server: Awaited<ReturnType<typeof startScriptedModelServer>>
}

const runFile = promisify(execFile)

async function sampleSockets(pid: number, sockets: string[]): Promise<void> {
  let output: string
  try { output = (await runFile("lsof", ["-a", "-i", "-p", String(pid), "-n", "-P"])).stdout }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 1)) throw error
    output = ""
  }
  for (const line of output.split("\n").slice(1).filter(Boolean)) {
    sockets.push(`${pid} ${line}`)
    const peer = line.split("->")[1]?.split(" ")[0]
    if (peer && !/^127\.|^\[::1\]:|^\[::ffff:127\./.test(peer)) throw new Error(`Claude connected beyond loopback: ${line}`)
  }
}

function watchedServices(services: TestServices, state: ClaudeBackend): TestServices {
  return { ...services, spawn: async (command, options) => {
    const owned = await services.spawn(command, options)
    state.commands.push(command)
    state.sampledPids.push(owned.pid)
    for (const delay of [25, 250, 750]) state.samples.push(new Promise<void>((resolve, reject) => {
      setTimeout(() => { void sampleSockets(owned.pid, state.sockets).then(resolve, reject) }, delay)
    }))
    return owned
  } }
}

function configurePorts(ports: MemoryPorts, state: Pick<ClaudeBackend, "config">): void {
  Object.assign(ports, { config: (sessionId: string) => ({ ...state.config,
    ...(ports.states.get(sessionId) ? { permissionState: ports.states.get(sessionId) } : {}) }) })
}

async function fileMode(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777
}

async function attachedClaude(state: ClaudeBackend, previous?: { ports: MemoryPorts; binding: HarnessBinding }) {
  const services = createTestServices()
  const ports = previous?.ports ?? new MemoryPorts()
  configurePorts(ports, state)
  Object.assign(ports, { clock: services.clock })
  ports.directories.set("s1", state.directory)
  ports.current.set("s1", { ...authority, directory: state.directory, ...(previous ? { upstreamSessionId: previous.binding.upstreamSessionId } : {}) })
  const owner = createRequestBroker(ports)
  const origin = { actor: state.owner, via: "relay" as const, reissued: false }
  const broker = createSessionBroker(owner, { sessionId: "s1", directory: state.directory, workspaceId: "w1", origin })
  const transport = new ClaudeSdkTransport(watchedServices(services, state), { executable: PINNED_CLAUDE, configRoot: state.configRoot,
    userConfigRoot: state.userConfigRoot, env: state.env })
  const start = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  const started = previous ? await transport.attach({ ...start, binding: previous.binding }, broker) : await transport.start(start, broker)
  const session = () => ({ ...started, binding: ports.bindings.get("s1") ?? started.binding })
  const turn = (turnId: string, text: string): TurnInput => ({ turnId, userMessageId: `u-${turnId}`, assistantMessageId: `a-${turnId}`, origin,
    model: state.model, prompt: { agent: "claude", assistantMessageId: `a-${turnId}`, parts: [{ type: "text", text }] }, todos: [] })
  const turnBroker = (turnId: string) => {
    ports.current.set("s1", { ...authority, directory: state.directory, upstreamSessionId: session().binding.upstreamSessionId, turnId })
    return createTurnBroker(owner, { authority: ports.current.get("s1")!, origin, signal: new AbortController().signal })
  }
  const pending = () => owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
  const collect = async (turnId: string, text: string) => {
    const events: RoutedEvent[] = []
    for await (const event of transport.send(session(), turn(turnId, text), turnBroker(turnId))) events.push(event)
    return events
  }
  const awaitPending = async () => {
    const found = await pollUntil(pending, Date.now() + 10_000)
    if (!found) throw new Error("Claude did not ask permission")
    return found
  }
  const collectWithoutAsk = async (turnId: string, text: string) => {
    const settled = new AbortController()
    const running = collect(turnId, text).finally(() => settled.abort())
    const asked = await Promise.race([running.then(() => undefined), pollUntil(pending, Date.now() + 15_000, settled.signal)])
    if (asked) await owner.broker.answer(asked.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })
    const events = await running
    expect(asked).toBeUndefined()
    return events
  }
  return { services, ports, owner, origin, broker, transport, session, turn, turnBroker, pending, awaitPending, collect, collectWithoutAsk,
    close: async () => { await transport.dispose() } }
}

async function backend(): Promise<ClaudeBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-conformance-"))
  const directory = path.join(root, "work")
  const userConfigRoot = path.join(root, "user-claude")
  const configRoot = path.join(root, "claxedo-claude")
  await fs.mkdir(directory)
  await fs.mkdir(userConfigRoot)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const authFile = path.join(userConfigRoot, ".credentials.json")
  await fs.writeFile(authFile, '{"sentinel":"owner-auth-must-stay"}\n')
  await fs.writeFile(path.join(userConfigRoot, "settings.json"), JSON.stringify({ apiKeyHelper: "printf wrong-account",
    env: { ANTHROPIC_API_KEY: "wrong-account" } }))
  const port = await reservePort()
  const proxyPort = await reservePort()
  const server = await startScriptedModelServer({ port, red: false })
  const attempts: string[] = []
  const sockets: string[] = []
  const samples: Promise<void>[] = []
  const sampledPids: number[] = []
  const commands: SpawnCommand[] = []
  const listener = createServer((request, response) => {
    attempts.push(`${request.method} ${request.url}`)
    response.writeHead(503).end()
  })
  listener.on("connect", (request, socket) => {
    attempts.push(`CONNECT ${request.url}`)
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n")
  })
  await new Promise<void>((resolve) => listener.listen(proxyPort, "127.0.0.1", resolve))
  const proxy = ["http:", "", `127.0.0.1:${proxyPort}`].join("/")
  const env = { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_GROWTHBOOK: "1", DISABLE_UPDATES: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" }
  const harness = { id: "claude" as const, access: "native" as const }
  const model = { providerID: "anthropic", modelID: "default" }
  return {
    root, directory, userConfigRoot, configRoot, env, attempts, sockets, samples, sampledPids, commands, listener, authFile, server,
    config: { harness, model, permissionMode: "default" }, alternateModel: { providerID: "anthropic", modelID: "sonnet" },
    owner: { kind: "person", userId: "owner" },
    sharedSender: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    harness: { id: "claude", access: "native" }, expectedMcp: "session",
    model: { providerID: "anthropic", modelID: "default" },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: { anthropic: { baseUrl: server.url, placeholder: "claude-conformance-placeholder", authMode: "api-key" } },
      secrets: {}, leaseGeneration: "conformance" },
    onSetup: ({ ports }) => configurePorts(ports, { config: { harness, model, permissionMode: "default" } }),
    unrunnableTurn: withUndeliverableFile,
    hold: (marker) => {
      const release = server.holdTextReplies(marker)
      if (marker === "PISTEER") void server.textGateReached(marker).then(() => setTimeout(release, 300))
      return release
    },
    held: (marker) => server.textGateReached(marker),
    scriptTool: (name, input) => server.scriptTool({ name: name === "read" ? "Read" : name, input: name === "read" ? { file_path: path.join(directory, "conformance.txt") } : input }),
    close: async () => {
      try {
        await Promise.all(samples)
        expect(samples).toHaveLength(sampledPids.length * 3)
      } finally {
        process.stdout.write(`CLAUDE_OUTBOUND_ATTEMPTS ${JSON.stringify(attempts)}\n`)
        process.stdout.write(`CLAUDE_SOCKETS ${JSON.stringify({ sampledPids, samples: samples.length, sockets })}\n`)
        listener.closeAllConnections()
        await new Promise<void>((resolve) => listener.close(() => resolve()))
        await server.close()
        releasePort(proxyPort)
        releasePort(port)
        await fs.rm(root, { recursive: true, force: true })
      }
      expect(attempts).toEqual([])
    },
  }
}

runConformance({
  name: "claude-sdk",
  backend,
  makeTransport(services, state) {
    const claude = state as ClaudeBackend
    return new ClaudeSdkTransport(watchedServices(services, claude), { executable: PINNED_CLAUDE,
      configRoot: claude.configRoot, userConfigRoot: claude.userConfigRoot, env: claude.env })
  },
})

test.each(["allow_once", "allow_always", "deny", "reject_always"])("Claude permission %s is saved before the tool continues", async (decision) => {
  const state = await backend()
  const services = createTestServices()
  const ports = new MemoryPorts()
  configurePorts(ports, state)
  Object.assign(ports, { clock: services.clock })
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = { actor: state.owner, via: "relay" as const, reissued: false }
  const broker = createSessionBroker(owner, { sessionId: "s1", directory: state.directory, workspaceId: "w1", origin })
  const transport = new ClaudeSdkTransport(watchedServices(services, state), { executable: PINNED_CLAUDE, configRoot: state.configRoot,
    userConfigRoot: state.userConfigRoot, env: state.env })
  try {
    const session = await transport.start({ sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
      config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }, broker)
    const committed = () => ({ ...session, binding: ports.bindings.get("s1") ?? session.binding })
    const target = path.join(state.directory, "permission-result.txt")
    const originalSettings = await fs.readFile(path.join(state.userConfigRoot, "settings.json"))
    state.scriptTool?.("Bash", { command: `printf approved > ${target}` })
    const turn = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, model: state.model,
      prompt: { agent: "claude", assistantMessageId: "a1", parts: [{ type: "text" as const, text: "Run the scripted Bash tool" }] }, todos: [] }
    const turnBroker = createTurnBroker(owner, { authority: { ...authority, directory: state.directory,
      upstreamSessionId: session.binding.upstreamSessionId }, origin, signal: new AbortController().signal })
    const running = (async () => { for await (const _event of transport.send(session, turn, turnBroker)) {} })()
    const deadline = Date.now() + 10_000
    let pending = owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    while (!pending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      pending = owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    }
    expect(pending?.request.kind).toBe("permission")
    if (!pending) throw new Error("Claude did not ask permission")
    expect(pending.upstreamSessionId).toBe(committed().binding.upstreamSessionId)
    if (decision === "allow_always") {
      ports.failPersist = true
      expect(await owner.broker.answer(pending.request.requestId, { kind: "permission", decision }, { sessionId: "s1" }))
        .toMatchObject({ ok: false, refusal: "persistence" })
      expect(await fs.stat(target).then(() => true, () => false)).toBe(false)
      expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
      ports.failPersist = false
    }
    const answer = await owner.broker.answer(pending.request.requestId, { kind: "permission", decision }, { sessionId: "s1" })
    expect(answer.ok).toBe(true)
    if (decision === "reject_always") await expect(running).rejects.toThrow()
    else await running
    expect(ports.saved.some((row) => row.pending.request.requestId === pending.request.requestId)).toBe(true)
    expect(await fs.stat(target).then(() => true, () => false)).toBe(decision.startsWith("allow"))
    expect(await fs.readFile(path.join(state.userConfigRoot, "settings.json"))).toEqual(originalSettings)
    if (decision === "allow_always") {
      expect(ports.states.get("s1")?.brokerGrants).toHaveLength(1)
      await fs.rm(target)
      state.server.scriptToolSequence("again", [{ name: "Bash", input: { command: `printf approved > ${target}` } }])
      const next = { ...turn, turnId: "t2", userMessageId: "u2", assistantMessageId: "a2",
        prompt: { ...turn.prompt, assistantMessageId: "a2", parts: [{ type: "text" as const, text: "Run the scripted Bash tool again" }] } }
      ports.current.set("s1", { ...authority, directory: state.directory, upstreamSessionId: committed().binding.upstreamSessionId, turnId: "t2" })
      const nextBroker = createTurnBroker(owner, { authority: { ...authority, directory: state.directory,
        upstreamSessionId: committed().binding.upstreamSessionId, turnId: "t2" }, origin, signal: new AbortController().signal })
      for await (const _event of transport.send(committed(), next, nextBroker)) {}
      expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
      expect(await fs.readFile(target, "utf8")).toBe("approved")
    }
  } finally {
    await transport.dispose()
    await state.close()
  }
}, 60_000)

test("Claude native Goal starts through provider admission and confirms clear", async () => {
  const state = await backend()
  const services = createTestServices()
  const ports = new MemoryPorts()
  configurePorts(ports, state)
  let currentGoal: RuntimeGoalSnapshot | null = null
  Object.assign(ports, { readGoal: () => currentGoal, publishGoal: async (_sessionId: string, snapshot: RuntimeGoalSnapshot | null) => {
    currentGoal = snapshot
  } })
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = { actor: state.owner, via: "relay" as const, reissued: false }
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const transport = new ClaudeSdkTransport(watchedServices(services, state), { executable: PINNED_CLAUDE, configRoot: state.configRoot,
    userConfigRoot: state.userConfigRoot, env: state.env })
  const release = state.server.holdTextReplies("CLAUDEGOAL")
  try {
    const session = await transport.start({ sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
      config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }, broker)
    const started = await transport.goals.start(session, "Reply with exactly this one token: CLAUDEGOAL", broker)
    expect(started.ok).toBe(true)
    const until = Date.now() + 10_000
    while (!broker.goal.read() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(broker.goal.read()).not.toBeNull()
    const stopped = await transport.goals.stop({ ...session, binding: ports.bindings.get("s1") ?? session.binding })
    expect(stopped.ok).toBe(true)
    expect(broker.goal.read()?.status).toBe("paused")
  } finally { release(); await transport.dispose(); await state.close() }
}, 60_000)

test("a requested Claude agent changes the real CLI query", async () => {
  const state = await backend()
  const services = createTestServices()
  const ports = new MemoryPorts()
  configurePorts(ports, state)
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = { actor: state.owner, via: "relay" as const, reissued: false }
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const transport = new ClaudeSdkTransport(watchedServices(services, state), { executable: PINNED_CLAUDE, configRoot: state.configRoot,
    userConfigRoot: state.userConfigRoot, env: state.env })
  try {
    await fs.mkdir(path.join(state.userConfigRoot, "agents"))
    await fs.writeFile(path.join(state.userConfigRoot, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Review work\nmodel: haiku\n---\nCLAUDE_AGENT_MARKER_REVIEWER\n")
    const session = await transport.start({ sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local",
      owner: state.owner, config: { harness: state.harness, model: state.model }, model: state.model,
      credentials: state.credentials, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }, broker)
    const turnBroker = createTurnBroker(owner, { authority: { ...authority, directory: state.directory,
      upstreamSessionId: session.binding.upstreamSessionId }, origin, signal: new AbortController().signal })
    const turn = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, model: state.model,
      prompt: { agent: "reviewer", assistantMessageId: "a1", parts: [{ type: "text" as const, text: "Review this work" }] }, todos: [] }
    for await (const _event of transport.send(session, turn, turnBroker)) {}
    const committed = { ...session, binding: ports.bindings.get("s1") ?? session.binding }
    expect((await transport.agents.list({ session: committed })).some((agent) => agent.name === "reviewer")).toBe(true)
    expect(state.server.requests.some((request) => request.model.includes("haiku"))).toBe(true)
  } finally { await transport.dispose(); await state.close() }
}, 60_000)

test("a saved Claude grant survives transport recreation and stays in its session", async () => {
  const ports = new MemoryPorts()
  const services = createTestServices()
  const owner = createRequestBroker(ports)
  const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
  const input = (sessionId: string) => ({ sessionId, workspaceId: "w1", directory: "/work", locality: "local" as const,
    owner: origin.actor, config: { harness: { id: "claude" as const, access: "native" as const }, permissionMode: "default" },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } })
  const options = { signal: new AbortController().signal, blockedPath: "/work" } as Parameters<CanUseTool>[2]
  const transport = () => new ClaudeSdkTransport(services, { executable: PINNED_CLAUDE, configRoot: "/tmp/claude-grants",
    userConfigRoot: "/tmp/claude-owner", env: {} })
  const first = transport()
  const firstSessions = [] as Awaited<ReturnType<typeof first.start>>[]
  for (const sessionId of ["s1", "s2"]) {
    ports.current.set(sessionId, { ...authority, sessionId, connectionId: "claude-sdk" })
    ports.directories.set(sessionId, "/work")
    const broker = createSessionBroker(owner, { sessionId, workspaceId: "w1", directory: "/work", origin })
    firstSessions.push(await first.start(input(sessionId), broker))
  }
  const turn = (brokerOwner: typeof owner, sessionId: string) => createTurnBroker(brokerOwner, {
    authority: ports.current.get(sessionId)!, origin, signal: new AbortController().signal })
  const initial = askClaudePermission(input("s1"), turn(owner, "s1"), "Bash", { command: "echo shared" }, options)
  for (let index = 0; index < 12; index++) await Promise.resolve()
  const pending = owner.broker.list({ sessionId: "s1" })[0]
  expect(pending?.request.kind).toBe("permission")
  expect(await owner.broker.answer(pending!.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" }))
    .toMatchObject({ ok: true })
  expect((await initial).behavior).toBe("allow")
  await first.dispose()

  const restartedOwner = createRequestBroker(ports)
  const second = transport()
  for (const [index, sessionId] of ["s1", "s2"].entries()) {
    const broker = createSessionBroker(restartedOwner, { sessionId, workspaceId: "w1", directory: "/work", origin })
    await second.attach({ ...input(sessionId), binding: firstSessions[index]!.binding }, broker)
  }
  try {
    const reused = await askClaudePermission(input("s1"), turn(restartedOwner, "s1"), "Bash", { command: "echo shared" }, options)
    expect(reused.behavior).toBe("allow")
    expect(restartedOwner.broker.list({ sessionId: "s1" })).toHaveLength(0)
    const isolated = askClaudePermission(input("s2"), turn(restartedOwner, "s2"), "Bash", { command: "echo shared" }, options)
    for (let index = 0; index < 12; index++) await Promise.resolve()
    const separate = restartedOwner.broker.list({ sessionId: "s2" })[0]
    expect(separate?.request.kind).toBe("permission")
    expect(await restartedOwner.broker.answer(separate!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s2" }))
      .toMatchObject({ ok: true })
    expect((await isolated).behavior).toBe("deny")
  } finally { await second.dispose() }
})

test("the deny floor is Claude's rule alone: a floor command Claude asks about still reaches the person", async () => {
  const ports = new MemoryPorts()
  const owner = createRequestBroker(ports)
  ports.current.set("s1", { ...authority, connectionId: "claude-sdk" })
  const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
  const broker = createTurnBroker(owner, { authority: ports.current.get("s1")!, origin, signal: new AbortController().signal })
  const input = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local" as const,
    owner: origin.actor, config: { harness: { id: "claude" as const, access: "native" as const } },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }
  const reply = askClaudePermission(input, broker, "Bash", { command: "rm -rf ~mine" },
    { signal: new AbortController().signal } as Parameters<CanUseTool>[2])
  const pending = await pollUntil(() => owner.broker.list({ sessionId: "s1" })[0], Date.now() + 2_000)
  expect(pending?.request.kind).toBe("permission")
  expect(ports.saved).toHaveLength(0)
  expect(await owner.broker.answer(pending!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).toMatchObject({ ok: true })
  expect((await reply).behavior).toBe("deny")
})

test.each([...sdkModes])("the Claude profile's deny floor holds in %s mode, visibly, without a broker request", async (mode: string) => {
  const state = await backend()
  state.config.permissionMode = mode
  const context = await attachedClaude(state)
  const floor = path.join(state.root, "floor")
  await fs.mkdir(floor, { mode: 0o700 })
  try {
    state.server.scriptTool({ name: "Bash", input: { command: `chmod -R 777 ${floor}` } })
    const events = await context.collect("t1", "Run the scripted Bash tool")
    expect(context.owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
    expect(context.ports.saved).toHaveLength(0)
    expect(await fileMode(floor)).toBe(0o700)
    expect(events.some((row) => row.event.type === "tool-error" && /has been denied/.test(row.event.error))).toBe(true)
  } finally { await context.close(); await state.close() }
}, 60_000)

test("a command outside the floor runs unprompted in bypassPermissions mode", async () => {
  const state = await backend()
  state.config.permissionMode = "bypassPermissions"
  const context = await attachedClaude(state)
  const outside = path.join(state.root, "outside")
  await fs.mkdir(outside, { mode: 0o700 })
  try {
    state.server.scriptTool({ name: "Bash", input: { command: `chmod -R 755 ${outside}` } })
    const events = await context.collectWithoutAsk("t1", "Run the scripted Bash tool")
    expect(await fileMode(outside)).toBe(0o755)
    expect(events.some((row) => row.event.type === "tool-error")).toBe(false)
  } finally { await context.close(); await state.close() }
}, 60_000)

test("a permission mode set in the runtime's config reaches the next Claude launch", async () => {
  const state = await backend()
  const context = await attachedClaude(state)
  const out = path.join(state.directory, "out.txt")
  try {
    state.config.permissionMode = "bypassPermissions"
    expect((await context.transport.config.permissionModes({ session: context.session() })).currentModeId).toBe("bypassPermissions")
    expect(await context.transport.config.read(context.session())).toMatchObject({ permissionMode: "bypassPermissions" })
    state.server.scriptTool({ name: "Bash", input: { command: `printf hi > ${out}` } })
    await context.collectWithoutAsk("t1", "Run the scripted Bash tool")
    expect(await fs.readFile(out, "utf8")).toBe("hi")
  } finally { await context.close(); await state.close() }
}, 60_000)

test("the config preview names the runtime's current model, not the start model", async () => {
  const state = await backend()
  const context = await attachedClaude(state)
  try {
    state.config.model = { providerID: "anthropic", modelID: "sonnet" }
    const current = await context.transport.config.options({ session: context.session() }, "probe")
    expect(current.resolvedModel?.id).toBe("sonnet")
    const requested = await context.transport.config.options({ session: context.session(), model: { providerID: "anthropic", modelID: "haiku" } }, "probe")
    expect(requested.resolvedModel?.id).toBe("haiku")
  } finally { await context.close(); await state.close() }
}, 60_000)

test("Claude offers no model before a live probe of the real CLI and marks the CLI's default", async () => {
  const state = await backend()
  const context = await attachedClaude(state)
  try {
    expect((await context.transport.config.options({ session: context.session() }, "peek")).options).toEqual([])
    expect(context.services.processes).toHaveLength(0)
    const [model] = (await context.transport.config.options({ session: context.session() }, "probe")).options
    expect(context.services.processes).toHaveLength(1)
    expect(model?.currentValue).toBe("default")
    expect(model?.selectOptions?.map((row) => row.id)).toContain("default")
  } finally { await context.close(); await state.close() }
}, 60_000)

test.each(["api-key", "bearer"] as const)("a live Claude %s projection authenticates every real CLI model request without the operator credentials", async (authMode) => {
  const state = await backend()
  state.env = { ...state.env, ANTHROPIC_API_KEY: "operator-own", ANTHROPIC_AUTH_TOKEN: "operator-own",
    CLAUDE_CODE_OAUTH_TOKEN: "operator-own", CLAUDE_CODE_OAUTH_SCOPES: "operator-own" }
  state.credentials = { ...state.credentials, providers: {
    anthropic: { baseUrl: state.server.url, placeholder: "live-placeholder", authMode, expiresAt: Date.now() + 60_000 },
  } }
  const context = await attachedClaude(state)
  try {
    await context.collect("t1", "Reply with exactly this one token: LIVEPROJECTION")
    expect(state.server.requests.some((row) => row.prompt.includes("LIVEPROJECTION"))).toBe(true)
    expect(state.commands.map((command) => command.env.ANTHROPIC_BASE_URL)).toEqual([state.server.url])
    expect(state.commands.flatMap((command) => Object.entries(command.env)).filter(([, value]) => value === "operator-own")).toEqual([])
    expect(new Set(state.server.requests.map((row) => row.authorization)))
      .toEqual(new Set([authMode === "api-key" ? "live-placeholder" : "Bearer live-placeholder"]))
  } finally { await context.close(); await state.close() }
}, 60_000)

test("Always allow persists Claude's suggested rules through the broker's grants and replays them on the next launch", async () => {
  const state = await backend()
  const first = await attachedClaude(state)
  const outside = path.join(state.root, "outside")
  await fs.mkdir(outside, { mode: 0o700 })
  const command = `chmod -R 750 ${outside}`
  const originalSettings = await fs.readFile(path.join(state.userConfigRoot, "settings.json"))
  let second: Awaited<ReturnType<typeof attachedClaude>> | undefined
  try {
    state.server.scriptTool({ name: "Bash", input: { command } })
    const running = first.collect("t1", "Run the scripted Bash tool")
    const pending = await first.awaitPending()
    expect(JSON.parse(pending.request.kind === "permission" ? pending.request.grantKey ?? "null" : "null"))
      .toMatchObject({ identity: expect.stringMatching(/^[0-9a-f]{64}$/), updates: [{ type: "addRules", behavior: "allow", destination: "session",
        rules: [{ toolName: "Bash", ruleContent: command }] }] })
    expect(await first.owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" }))
      .toMatchObject({ ok: true })
    await running
    expect(await fileMode(outside)).toBe(0o750)
    expect(first.ports.states.get("s1")?.brokerGrants).toHaveLength(1)
    expect(first.ports.saved).toHaveLength(1)
    expect(await fs.readFile(path.join(state.userConfigRoot, "settings.json"))).toEqual(originalSettings)
    expect(await fs.stat(path.join(state.directory, ".claude")).then(() => true, () => false)).toBe(false)
    const binding = first.session().binding
    await first.close()
    await fs.chmod(outside, 0o700)
    second = await attachedClaude(state, { ports: first.ports, binding })
    state.server.scriptToolSequence("AGAIN", [{ name: "Bash", input: { command } }])
    await second.collectWithoutAsk("t2", "AGAIN: run the scripted Bash tool")
    expect(second.ports.saved).toHaveLength(1)
    expect(await fileMode(outside)).toBe(0o750)
  } finally { await second?.close(); await first.close(); await state.close() }
}, 90_000)

function goalStream(messages: AsyncIterable<SDKMessage>): Query {
  return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close() {} } as Query
}

const goalEntry = () => ({ session: { directory: "/work", locality: "local" as const, binding: { sessionId: "s1", workspaceId: "w1", directory: "/work",
  connectionId: "claude-sdk", upstreamSessionId: "up1" } }, input: { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local" as const,
  owner: { kind: "machine-owner" as const }, config: { harness: { id: "claude" as const, access: "native" as const } },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } } })

function abortingLauncher(): ClaudeQueryLauncher {
  return { launch: async (spec: Parameters<ClaudeQueryLauncher["launch"]>[0]) => goalStream({ async *[Symbol.asyncIterator]() {
    yield { type: "active_goal", session_id: "up1", uuid: "g1", value: { condition: "Ship", iterations: 1, set_at: 1_700_000_000, tokens_at_start: 0 } } as unknown as SDKMessage
    if (!spec.abort.signal.aborted) await new Promise<void>((resolve) => spec.abort.signal.addEventListener("abort", () => resolve(), { once: true }))
    throw new AbortError("aborted")
  } }) } as unknown as ClaudeQueryLauncher
}

function memoryBroker() {
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, connectionId: "claude-sdk" })
  let goal: import("@claxedo/agent-runtime-contract").RuntimeGoalSnapshot | null = null
  Object.assign(ports, { readGoal: () => goal, publishGoal: async (_sessionId: string, snapshot: typeof goal) => { goal = snapshot } })
  const broker = createSessionBroker(createRequestBroker(ports), { sessionId: "s1", workspaceId: "w1", directory: "/work", origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false } })
  return { ports, broker }
}

test("a runtime cancel of the admitted Goal turn settles cancelled and pauses the Goal", async () => {
  const { ports, broker } = memoryBroker()
  const goals = new ClaudeGoals(abortingLauncher())
  expect((await goals.start(goalEntry(), broker, "Ship")).ok).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(broker.goal.read()?.status).toBe("active")
  ports.cancelProviderTurn()
  expect(await goals.cancel("s1")).toEqual({ state: "cancelled" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(broker.goal.read()?.status).toBe("paused")
  expect(goals.turnId("s1")).toBeUndefined()
})

test("the transport's own Goal abort ends the run as a cancellation, not a failure", async () => {
  const { broker } = memoryBroker()
  const goals = new ClaudeGoals(abortingLauncher())
  expect((await goals.start(goalEntry(), broker, "Ship")).ok).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await goals.cancel("s1")).toEqual({ state: "completed" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(broker.goal.read()?.status).toBe("active")
})

describe("Claude permission persistence", () => {
  const suggestions: PermissionUpdate[] = [
    { type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "printf approved-write *" }] },
    { type: "addDirectories", destination: "session", directories: ["/tmp/approved"] },
  ]
  type Decision = "allow_always" | "allow_once" | "deny" | "reject_always"
  type Overrides = { directory?: string; mode?: string; tool?: string; input?: Record<string, unknown>; context?: Record<string, unknown> }

  function fixture() {
    const ports = new MemoryPorts()
    let owner = createRequestBroker(ports)
    let decision: Decision = "deny"
    let count = 0
    const answers: Promise<unknown>[] = []
    ports.publish = async (event, pending) => {
      await MemoryPorts.prototype.publish.call(ports, event, pending)
      if (!pending) return
      count++
      answers.push(owner.broker.answer(pending.request.requestId, { kind: "permission", decision }, { sessionId: pending.sessionId }))
    }
    const input = (sessionId: string, overrides: Overrides = {}): StartInput => ({
      sessionId, workspaceId: "w1", directory: overrides.directory ?? "/work", locality: "local", owner: origin.actor,
      config: { harness: { id: "claude", access: "native" }, permissionMode: overrides.mode ?? "default", permissionState: ports.states.get(sessionId) },
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" },
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    })
    const run = async (sessionId: string, answer: Decision, overrides: Overrides = {}) => {
      decision = answer
      const start = input(sessionId, overrides)
      const current = { ...authority, sessionId, directory: start.directory, connectionId: "claude-sdk", turnId: `turn-${count}` }
      ports.current.set(sessionId, current)
      ports.directories.set(sessionId, start.directory)
      owner = createRequestBroker(ports)
      const broker = createTurnBroker(owner, { authority: current, origin, signal: new AbortController().signal })
      return askClaudePermission(start, broker, overrides.tool ?? "Bash", overrides.input ?? { command: "printf approved-write > /tmp/approved/result" }, {
        signal: new AbortController().signal, toolUseID: `tool-${count}`, requestId: `request-${count}`, suggestions, blockedPath: "/tmp/approved/result", ...overrides.context,
      } as Parameters<CanUseTool>[2])
    }
    const options = async (sessionId: string) => {
      const start = input(sessionId)
      let captured: Parameters<typeof query>[0] | undefined
      const launch = new ClaudeQueryLauncher({ firstPartyMcp: () => undefined } as unknown as HarnessServices,
        { executable: "claude", configRoot: "/tmp/claude-permissions", userConfigRoot: "/tmp/claude-permissions-owner", env: {} },
        ((call) => { captured = call; return {} as Query }) as typeof query)
      const broker = { sessionId, config: () => start.config } as SessionBroker
      await launch.launch({ input: start, session: { directory: start.directory, locality: start.locality,
        binding: { ...authority, sessionId, connectionId: "claude-sdk" } },
        broker, abort: new AbortController(), processes: new Set(), prompt: "hello",
        usage: new ClaudeMirroredUsage(claudeTranslator("a1").runtime, { broker, assistantMessageId: "a1", directory: start.directory }) })
      const value = captured!.options!
      return { allow: (value.settings as { permissions: { allow: string[]; deny: string[] } }).permissions.allow,
        deny: (value.settings as { permissions: { deny: string[] } }).permissions.deny, directories: value.additionalDirectories }
    }
    return { ports, run, options, count: () => count, answers }
  }

  test.each(["allow_always", "allow_once", "deny"] as const)("%s recreates only accepted Claude rules and directories", async (decision) => {
    const f = fixture()
    expect((await f.run("s1", decision)).behavior).toBe(decision === "deny" ? "deny" : "allow")
    expect(await Promise.all(f.answers)).toEqual([{ ok: true, events: [] }])
    expect((await f.options("s1")).allow).toEqual(decision === "allow_always" ? ["Bash(printf approved-write *)"] : [])
    expect((await f.options("s1")).directories).toEqual(decision === "allow_always" ? ["/tmp/approved"] : [])
    expect((await f.options("s2")).allow).toEqual([])
    expect((await f.options("s2")).directories).toEqual([])
    expect((await f.options("s1")).deny).toEqual((await f.options("s2")).deny)
  })

  test("a failed Claude grant write releases no approval and leaves no reconstructed rules", async () => {
    const ports = new MemoryPorts()
    ports.failGrant = true
    const current = { ...authority, connectionId: "claude-sdk" }
    ports.current.set("s1", current)
    const owner = createRequestBroker(ports)
    const broker = createTurnBroker(owner, { authority: current, origin, signal: new AbortController().signal })
    const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local", owner: origin.actor,
      config: { harness: { id: "claude", access: "native" } }, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" },
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
    let published!: () => void
    const ready = new Promise<void>((resolve) => { published = resolve })
    ports.publish = async (event, pending) => { await MemoryPorts.prototype.publish.call(ports, event, pending); published() }
    let released = false
    const asking = askClaudePermission(input, broker, "Bash", { command: "echo approved" }, {
      signal: broker.signal, suggestions, toolUseID: "tool-1", requestId: "request-1", blockedPath: "/work",
    }).then((answer) => { released = true; return answer })
    await ready
    const row = owner.broker.list({ sessionId: "s1" })[0]!
    expect(await owner.broker.answer(row.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" }))
      .toMatchObject({ ok: false, refusal: "persistence", retryable: true })
    expect(released).toBe(false)
    expect(ports.states.size).toBe(0)
    expect(ports.saved).toHaveLength(0)
    await owner.endTurn(current)
    expect((await asking).behavior).toBe("deny")
  })

  test.each(["allow_always", "allow_once", "deny", "reject_always"] as const)("%s reuses only a persistent identical Claude request after broker recreation", async (decision) => {
    const f = fixture()
    const initial = await f.run("s1", decision)
    expect(initial.behavior).toBe(decision.startsWith("allow") ? "allow" : "deny")
    expect(f.count()).toBe(1)
    await f.run("s1", decision)
    expect(f.count()).toBe(decision === "allow_always" ? 1 : 2)
    await f.run("s1", decision, { input: { command: "printf approved-write > /tmp/approved/result", description: "new display label" },
      context: { title: "Claude wants to write the result", displayName: "Run command", description: "Writes the approved result" } })
    expect(f.count()).toBe(decision === "allow_always" ? 1 : 3)
  })

  test.each([
    ["mcp__notes__create", { description: "APPROVED-NOTE-BODY", target: "/work/note" }, { description: "CHANGED-NOTE-BODY", target: "/work/note" }],
    ["Task", { description: "APPROVED-TASK-SUMMARY", prompt: "Inspect the workspace", subagent_type: "general-purpose" },
      { description: "CHANGED-TASK-SUMMARY", prompt: "Inspect the workspace", subagent_type: "general-purpose" }],
    ["Write", { file_path: "/work/note.txt", content: "APPROVED-FILE-CONTENT" }, { file_path: "/work/note.txt", content: "CHANGED-FILE-CONTENT" }],
    ["Edit", { file_path: "/work/note.txt", old_string: "before", new_string: "APPROVED-EDIT-TEXT" },
      { file_path: "/work/note.txt", old_string: "before", new_string: "CHANGED-EDIT-TEXT" }],
  ] satisfies [string, Record<string, unknown>, Record<string, unknown>][])("a persisted %s grant stores none of its input and re-asks when that input changes", async (tool, input, changed) => {
    const f = fixture()
    const context = { suggestions: [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: tool }] }] }
    expect((await f.run("s1", "allow_always", { tool, context, input })).behavior).toBe("allow")
    expect((await f.run("s1", "deny", { tool, context, input })).behavior).toBe("allow")
    expect(f.count()).toBe(1)
    const stored = JSON.stringify([f.ports.states.get("s1"), f.ports.saved.map((row) => row.pending.request.kind === "permission" ? row.pending.request.grantKey : undefined),
      f.ports.published.filter((event) => event.type === "permission.auto-answered")])
    expect(stored).toContain("identity")
    expect(stored).not.toContain("APPROVED")
    expect((await f.run("s1", "deny", { tool, context, input: changed })).behavior).toBe("deny")
    expect(f.count()).toBe(2)
  })

  test.each([
    ["session", "s2", {}], ["directory", "s1", { directory: "/other" }], ["mode", "s1", { mode: "plan" }],
    ["tool", "s1", { tool: "Write", input: { file_path: "/tmp/result", content: "changed" } }],
    ["command", "s1", { input: { command: "rm /tmp/result" } }],
    ["blocked path", "s1", { context: { blockedPath: "/tmp/other" } }],
    ["agent", "s1", { context: { agentID: "child" } }],
    ["unknown policy", "s1", { context: { futurePolicy: "new" } }],
    ["ask rule", "s1", { context: { matchedAskRule: { toolName: "Bash" } } }],
    ["decision reason", "s1", { context: { decisionReason: "new safety check" } }],
  ] satisfies [string, string, Overrides][])("a saved Claude suggestion grant asks again when %s changes", async (_name, sessionId, overrides) => {
    const f = fixture()
    await f.run("s1", "allow_always")
    const result = await f.run(sessionId, "deny", overrides)
    expect(f.count()).toBe(2)
    expect(result.behavior).toBe("deny")
  })
})

describe("Claude SDK protocol", () => {
  const models = [
    { value: "haiku", displayName: "Haiku", description: "Fast", supportsEffort: false },
    { value: "default", displayName: "Default", description: "Default", supportsEffort: true, supportedEffortLevels: ["high", "max"] },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Deep", supportsEffort: true, supportedEffortLevels: ["high", "max"] },
  ]

  const fixture = (settings: { steering?: boolean } = {}) => scriptedClaude({ models, ...settings })

  test.each(["default", "claude-opus-5-5"])("a cold first Claude turn resolves %s and sends its effort through the SDK", async (model) => {
    const f = await fixture()
    try {
      await f.run(model, "high")
      expect(f.launches.map((row) => row.role)).toEqual(["probe", "harness"])
      const args = f.launches[1]!.command.args
      expect(args[args.indexOf("--model") + 1]).toBe(model)
      expect(args[args.indexOf("--effort") + 1]).toBe("high")
    } finally { await f.close() }
  })

  test.each([
    ["the home directory", {}, "."],
    ["CLAUDE_CONFIG_DIR", { CLAUDE_CONFIG_DIR: "set" }, "owner"],
  ] as const)("a kept Claude model answer is probed again when the CLI's account file in %s changes", async (_where, env, folder) => {
    const f = await scriptedClaude({ models, env })
    try {
      const probe = () => f.transport.config.options({ session: f.session }, "probe")
      await probe()
      await probe()
      expect(f.launches.map((row) => row.role)).toEqual(["probe"])
      await fs.mkdir(path.join(f.session.directory, folder), { recursive: true })
      await fs.writeFile(path.join(f.session.directory, folder, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "other@example.com" } }))
      await probe()
      expect(f.launches.map((row) => row.role)).toEqual(["probe", "probe"])
    } finally { await f.close() }
  })

  test("an unsupported Claude effort refuses the turn before a harness launch", async () => {
    const f = await fixture()
    try {
      await expect(f.run("haiku", "high")).rejects.toMatchObject({ code: "configuration", message: "Claude does not run haiku at effort high" })
      expect(f.launches.map((row) => row.role)).toEqual(["probe"])
    } finally { await f.close() }
  })

  test.each([true, false])("the Claude SDK consumes a steer and accepts it only with replay=%s", async (replay) => {
    const f = await fixture({ steering: true })
    try {
      const running = f.run("default")
      expect(await pollUntil(() => f.users.length === 1 ? true : undefined, Date.now() + 2000)).toBe(true)
      let accepted = false
      const input: TurnInput = { turnId: "steer", userMessageId: "u2", assistantMessageId: "a2", todos: [],
        origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
        prompt: { agent: "", assistantMessageId: "a2", parts: [{ type: "text", text: "more" }] } }
      const steering = f.transport.steer.steer(f.session, { turnId: "t1", assistantMessageId: "a1" }, input)
        .then((result) => { accepted = true; return result })
      expect(await pollUntil(() => f.users.length === 2 ? true : undefined, Date.now() + 2000)).toBe(true)
      expect(accepted).toBe(false)
      expect(f.users[1]?.uuid).toBeString()
      expect(f.launches[0]!.command.args).toContain("--replay-user-messages")
      if (replay) f.replay(1)
      f.finish()
      await running
      expect(await steering).toMatchObject(replay ? { ok: true } : { ok: false, status: "declined" })
      expect(f.users).toHaveLength(2)
    } finally { await f.close() }
  })

})

test("the /compact Claude declares runs Claude's own compaction", async () => {
  const state = await backend()
  const context = await attachedClaude(state)
  try {
    expect((await context.transport.commands.list({ session: context.session() })).some((command) => command.name === "compact")).toBe(true)
    expect((await context.collect("t1", "Reply with exactly this one token: CLAUDEWARM")).some((row) => row.event.type === "finish")).toBe(true)
    const before = state.server.requests.length
    const events = await context.collect("t2", "/compact")
    expect(events.some((row) => row.event.type === "finish")).toBe(true)
    const compaction = state.server.requests.slice(before).map((request) => request.prompt)
    expect(compaction.some((prompt) => prompt.includes("<summary>") && prompt.includes("CLAUDEWARM"))).toBe(true)
  } finally { await context.close(); await state.close() }
}, 60_000)
