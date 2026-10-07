import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runConformance, setupConformance, type ConformanceBackend, type SuiteBackend } from "./test-support/run"
import { filterMcpServers } from "../capabilities/mcp-filter"
import { AcpTransport } from "../transports/acp"
import { AcpTransportError } from "../transports/acp/errors"
import { acpUpdate } from "../transports/acp/events"
import type { AcpEntry } from "../transports/acp"
import { startScriptedAcpWebSocket } from "../../e2e/harness/acp/websocket"
import { startScriptedAcpHttp } from "../../e2e/harness/acp/http"
import { acpScriptToken, writeAcpScript } from "../../e2e/harness/acp/script"
import { readAcpRequests } from "../../e2e/harness/acp/requests"
import { expect, test } from "bun:test"
import { errorMessage } from "@claxedo/helpers"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority, origin } from "./test-support/memory-ports"
import { createTestServices } from "./test-support/services"
import { removeTempRoot } from "../test-support/temp-root"
import { assertListedCommandsRun } from "./test-support/commands"
import { SESSION_TITLE_SYSTEM_PROMPT } from "../../e2e/harness/config"

async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  const failure = await run().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  return errorMessage(failure)
}

type AcpBackend = ConformanceBackend & {
  root: string
  connection: ConstructorParameters<typeof AcpTransport>[1]
}

test("ACP launches the projected servers and reports the ones the projection could not apply", async () => {
  const context = await setupConformance({
    name: "acp partial MCP projection",
    backend: async () => ({ ...await backend("process"), projection: { generation: "partial", pluginRoots: [],
      notApplied: [{ item: "needs-cwd", reason: "unsupported-by-harness" as const }],
      mcpServers: [{ kind: "stdio" as const, origin: "plugin" as const, name: "supported", command: "/plugin/other" }] } }),
    makeTransport: (services, state) => new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers),
  })
  try {
    const request = (await readAcpRequests(context.backend.directory)).find((row) => row.method === "session/new")
    expect(request?.params).toMatchObject({ mcpServers: [expect.objectContaining({ name: "supported" })] })
    expect(context.ports.sessionEvents).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      type: "harness-notice", details: { notApplied: [{ item: "needs-cwd", reason: "unsupported-by-harness" }] },
    }) }))
  } finally { await context.close() }
})

async function backend(kind: "process" | "websocket" | "streamable-http", restoreMode: "resume" | "load" = "resume", supportsMcpServers = true,
  holdMethod?: string, red = false, startupQuestion = false, groups?: readonly string[]): Promise<AcpBackend & SuiteBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-conformance-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await writeAcpScript(directory, "permission", { steps: [
    { kind: "permission", tool: "execute", title: "Run scripted command", text: "permission result" },
    { kind: "text", text: "Permission scenario finished" },
  ] })
  await writeAcpScript(directory, "text", { steps: [
    { kind: "text", text: "PICONFORM" }, { kind: "usage", used: 12, size: 4096 },
  ] })
  await writeAcpScript(directory, "usage", { steps: [{ kind: "text", text: "USAGE" }],
    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16, thoughtTokens: 2, cachedReadTokens: 1, cachedWriteTokens: 0 } })
  await writeAcpScript(directory, "silence", { steps: [{ kind: "hold", name: "never-released" }] })
  await writeAcpScript(directory, "permission-silence", { steps: [
    { kind: "permission", tool: "execute", title: "Run scripted command", text: "permission result" },
    { kind: "hold", name: "never-released" },
  ] })
  await writeAcpScript(directory, "subagent", { steps: [{ kind: "subagent", name: "Researcher", task: "Inspect the file",
    steps: [{ kind: "text", text: "Child result" }] }] })
  await writeAcpScript(directory, "refused", { steps: [{ kind: "error", message: "Scripted ACP refused this prompt" }] })
  await writeAcpScript(directory, "permission-refused", { steps: [
    { kind: "permission", tool: "execute", title: "Run scripted command", text: "permission result" },
    { kind: "error", message: "Scripted ACP refused after permission" },
  ] })
  const server = kind === "websocket" ? await startScriptedAcpWebSocket(directory, { restoreMode, holdMethod, startupQuestion, groups })
    : kind === "streamable-http" ? await startScriptedAcpHttp(directory, { restoreMode, startupQuestion, groups }) : undefined
  const connection = kind === "websocket" && server
    ? { kind: "websocket" as const, url: server.url, supportsMcpServers }
    : kind === "streamable-http" && server
      ? { kind: "streamable-http" as const, url: server.url, supportsMcpServers }
      : { kind: "process" as const, command: process.execPath,
      args: [path.join(import.meta.dirname, "../../e2e/harness/acp/agent.ts")],
      env: { SCRIPTED_ACP_DIR: directory, ...(holdMethod === "session/new" ? { SCRIPTED_ACP_HANG_NEW: "1" } : {}),
        ...(red ? { SCRIPTED_ACP_RED: "1" } : {}), ...(startupQuestion ? { SCRIPTED_ACP_START_QUESTION: "1" } : {}),
        ...(groups ? { SCRIPTED_ACP_GROUPS: groups.join(",") } : {}) } }
  return {
    root, directory, connection, locality: server ? "remote" : "local",
    harness: { id: "scripted-acp", access: "connection" },
    model: { providerID: "scripted-acp", modelID: "default" },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "conformance" },
    owner: { kind: "machine-owner" as const },
    ...(server ? {
      projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [
        { kind: "http" as const, name: "configured-http", url: "http://127.0.0.1:47355/mcp", origin: "configured" as const },
        { kind: "sse" as const, name: "configured-sse", url: "http://127.0.0.1:47356/sse", origin: "configured" as const },
        { kind: "stdio" as const, name: "configured-stdio", command: "never-run", origin: "configured" as const },
        { kind: "http" as const, name: "plugin-http", url: "http://127.0.0.1:47357/mcp", origin: "plugin" as const },
      ] },
      configureServices: (services: Parameters<NonNullable<ConformanceBackend["configureServices"]>>[0]) => {
        services.firstPartyMcp = () => ({ kind: "http", name: "claxedo-own", url: "http://127.0.0.1:47358/mcp",
          headers: { Authorization: "Bearer owner-secret" } })
      },
      verifyRemoteMcp: async () => {
        const requests = await readAcpRequests(directory)
        for (const method of ["session/new", "session/fork", restoreMode === "load" ? "session/load" : "session/resume"]) {
          const row = requests.find((item) => item.method === method)
          expect(row).toBeDefined()
          const servers = row?.params.mcpServers as { name: string }[]
          expect(servers.map((item) => item.name).sort()).toEqual(supportsMcpServers ? ["configured-http", "configured-sse"] : [])
          expect(JSON.stringify(row)).not.toContain("owner-secret")
        }
      },
    } : {}),
    credentialsAfterActiveTurns: true, textCommand: acpScriptToken("text"), permissionCommand: acpScriptToken("permission"),
    scriptThinking: async ({ text, reasoning }) => {
      await writeAcpScript(directory, "thinking", { steps: [{ kind: "reasoning", text: reasoning }, { kind: "text", text }] })
      return acpScriptToken("thinking")
    },
    unrunnableTurn: (turn) => ({ ...turn, prompt: { ...turn.prompt, parts: [{ type: "text", text: acpScriptToken("refused") }] } }),
    close: async () => { await server?.close(); await removeTempRoot(root) },
  }
}

for (const kind of ["process", "websocket", "streamable-http"] as const) {
  runConformance({
    name: `acp ${kind}`,
    backend: () => backend(kind),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
}

test("every listed ACP command runs as a slash prompt", async () => {
  const context = await setupConformance({ name: "acp command proof", backend: () => backend("process"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    } })
  try {
    await assertListedCommandsRun({ transport: context.transport, session: context.session, turn: context.turn,
      turnBroker: context.turnBroker, args: () => acpScriptToken("text"),
      observe: (_name, events) => expect(events.some(({ event }) => JSON.stringify(event).includes("PICONFORM"))).toBe(true) })
  } finally { await context.close() }
}, 60_000)

runConformance({
  name: "acp websocket load",
  backend: () => backend("websocket", "load"),
  makeTransport(services, state) {
    const peer = state as AcpBackend
    return new AcpTransport(services, peer.connection, filterMcpServers)
  },
})

test("an ACP agent that no longer has the session refuses the attach with a typed error and no replacement session", async () => {
  const context = await setupConformance({
    name: "acp missing session",
    backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    await context.transport.close(context.session)
    const rebinds: string[] = []
    context.ports.rebind = async (_sessionId, upstreamSessionId) => {
      rebinds.push(upstreamSessionId)
      return { ...context.started.binding, upstreamSessionId }
    }
    const attached = context.transport.attach({ ...context.start,
      binding: { ...context.session.binding, upstreamSessionId: "missing-session" }, upstreamHasTurns: true }, context.sessionBroker)
    const error = await attached.then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(AcpTransportError)
    expect(error).toMatchObject({ code: "session", message: "ACP agent no longer has session missing-session; it is not replaced" })
    expect(rebinds).toEqual([])
    const requests = await readAcpRequests(context.backend.directory)
    expect(requests.map((item) => item.method)).toContain("session/resume")
    expect(requests.filter((item) => item.method === "session/new")).toHaveLength(1)
  } finally { await context.close() }
})

test("ACP advertises session notices, and a notice the agent sends is a harness notice in the turn", async () => {
  const context = await setupConformance({
    name: "acp notice", backend: () => backend("process"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    await writeAcpScript(context.backend.directory, "notice", { steps: [
      { kind: "notice", severity: "warning", title: "Rate limit approaching", description: "Requests slow down after 80%." },
      { kind: "text", text: "Done" },
    ] })
    const events: unknown[] = []
    for await (const routed of context.transport.send(context.session, context.turn(acpScriptToken("notice")), context.turnBroker())) events.push(routed.event)
    expect(events).toContainEqual(expect.objectContaining({ type: "harness-notice", code: "acp.notice", severity: "warn",
      message: "Rate limit approaching. Requests slow down after 80%." }))
    expect(JSON.stringify(events)).not.toContain("Rate limit approaching Requests")
  } finally { await context.close() }
})

test("ACP publishes a command update received outside a turn", async () => {
  const context = await setupConformance({
    name: "acp outside commands", backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    for (let attempt = 0; !context.ports.sessionEvents.some((row) => (row.event as { type?: string }).type === "available-commands-update") && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(context.ports.sessionEvents).toContainEqual(expect.objectContaining({ sessionId: "s1",
      event: expect.objectContaining({ type: "available-commands-update" }) }))
  } finally { await context.close() }
})

test("a busy workspace does not hold another workspace's ACP config restart", async () => {
  const context = await setupConformance({
    name: "acp workspace restart",
    backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    const secondDirectory = path.join((context.backend as AcpBackend).root, "other")
    await fs.mkdir(secondDirectory)
    const secondStart = { ...context.start, sessionId: "s2", workspaceId: "w2", directory: secondDirectory }
    context.ports.current.set("s2", { ...authority, sessionId: "s2", directory: secondDirectory, workspaceId: "w2" })
    context.ports.directories.set("s2", secondDirectory)
    const secondBroker = createSessionBroker(context.owner, { sessionId: "s2", directory: secondDirectory,
      workspaceId: "w2", origin })
    const secondSession = await context.transport.start(secondStart, secondBroker)
    const running = (async () => {
      const events = []
      for await (const event of context.transport.send(context.session, context.turn(context.backend.permissionCommand!), context.turnBroker())) events.push(event)
      return events
    })()
    let pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    for (let attempt = 0; !pending && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    }
    expect(pending).toBeDefined()
    const changed = { ...context.start.projection, generation: "plugins:rotated" }
    expect(await context.transport.configure(context.session, { projection: changed })).toEqual({ state: "deferred", until: "after-active-turns" })
    const beforeReply = await readAcpRequests(context.backend.directory)
    expect(beforeReply.some((row) => row.method === "session/resume" && row.params.cwd === secondDirectory)).toBe(false)
    expect(beforeReply.some((row) => row.method === "session/resume" && row.params.cwd === context.backend.directory)).toBe(false)
    const answer = await context.owner.broker.answer(pending!.request.requestId,
      { kind: "permission", decision: "deny" }, { sessionId: "s1" })
    expect(answer.ok).toBe(true)
    await running
    let restarted = await readAcpRequests(context.backend.directory)
    for (let attempt = 0; !restarted.some((row) => row.method === "session/resume" && row.params.cwd === context.backend.directory) && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      restarted = await readAcpRequests(context.backend.directory)
    }
    expect(restarted.some((row) => row.method === "session/resume" && row.params.cwd === context.backend.directory)).toBe(true)
    expect(restarted.some((row) => row.method === "session/resume" && row.params.cwd === secondSession.directory)).toBe(false)
  } finally { await context.close() }
})

test("a hung ACP session/new times out and retires its started process", async () => {
  let processes: Parameters<NonNullable<ConformanceBackend["configureServices"]>>[0]["processes"] = []
  await expect(setupConformance({
    name: "acp hung new",
    async backend() {
      const peer = await backend("process", "resume", true, "session/new")
      return { ...peer, configureServices(services) { processes = services.processes },
        connection: { ...peer.connection, startupTimeoutMs: 500 } }
    },
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })).rejects.toThrow("session/new timed out")
  expect(processes).toHaveLength(1)
  expect((await processes[0]!.exited).signal).not.toBeNull()
})

test("a hung ACP initialize retires its process", async () => {
  let processes: ReturnType<typeof createTestServices>["processes"] = []
  await expect(setupConformance({
    name: "acp hung initialize",
    async backend() {
      const peer = await backend("process")
      return { ...peer, connection: { kind: "process" as const, command: process.execPath,
        args: ["-e", "process.stdin.resume()"], startupTimeoutMs: 100 },
        configureServices(services) { processes = services.processes } }
    },
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })).rejects.toThrow("initialize timed out")
  expect(processes).toHaveLength(1)
  expect(await processes[0]!.exited).toBeDefined()
})

test("a synchronous ACP spawn failure reaches the caller unchanged", async () => {
  const launchError = new Error("original launch failure")
  await expect(setupConformance({
    name: "acp synchronous spawn refusal",
    async backend() {
      const peer = await backend("process")
      return { ...peer, configureServices(services) { services.spawn = () => { throw launchError } } }
    },
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })).rejects.toBe(launchError)
})

test("an ACP process exiting during initialize reports its exit code and retires", async () => {
  let processes: ReturnType<typeof createTestServices>["processes"] = []
  await expect(setupConformance({
    name: "acp synchronous exit",
    async backend() {
      const peer = await backend("process")
      return { ...peer, connection: { kind: "process" as const, command: process.execPath,
        args: ["-e", "process.exit(17)"], startupTimeoutMs: 1_000 },
        configureServices(services) { processes = services.processes } }
    },
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })).rejects.toThrow("code 17")
  expect(processes).toHaveLength(1)
  expect(await processes[0]!.exited).toMatchObject({ code: 17 })
})

test("ACP harness and probe spawns carry observer metadata without launch secrets", async () => {
  const descriptors: unknown[] = []
  const context = await setupConformance({
    name: "acp spawn descriptors",
    async backend() {
      const peer = await backend("process")
      return { ...peer, credentials: { ...peer.credentials, secrets: { SCRIPTED_SECRET: "sensitive-value" } },
        configureServices(services) {
          const spawn = services.spawn.bind(services)
          services.spawn = (command, options) => { descriptors.push(options); return spawn(command, options) }
        } }
    },
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
    await context.transport.config?.options({ draft }, "probe")
    expect(descriptors).toEqual([
      { role: "harness", label: "ACP", sessionId: "s1", signal: expect.any(AbortSignal) },
      { role: "probe", label: "ACP", sessionId: expect.stringMatching(/^probe-/), signal: expect.any(AbortSignal) },
    ])
    expect(JSON.stringify(descriptors)).not.toContain("sensitive-value")
  } finally { await context.close() }
})

test.skipIf(process.platform === "win32")("ACP retirement waits for a resistant descendant before another peer starts", async () => {
  const context = await setupConformance({
    name: "acp resistant descendant",
    async backend() {
      const peer = await backend("process")
      if (peer.connection.kind !== "process") throw new Error("Expected a process connection")
      return { ...peer, connection: { ...peer.connection,
        env: { ...peer.connection.env, SCRIPTED_ACP_RESISTANT_CHILD: "1" } } }
    },
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const oldWriter = Number(await fs.readFile(path.join(context.backend.directory, "writer.pid"), "utf8"))
    expect(oldWriter).toBeGreaterThan(1)
    await context.transport.close(context.session)
    expect(await context.services.processes[0]!.exited).toBeDefined()
    context.ports.current.set("s2", { ...authority, sessionId: "s2" })
    context.ports.directories.set("s2", context.backend.directory)
    const secondBroker = createSessionBroker(context.owner, { sessionId: "s2", directory: context.backend.directory,
      workspaceId: context.start.workspaceId, origin })
    const next = await context.transport.start({ ...context.start, sessionId: "s2" }, secondBroker)
    expect(next.binding.upstreamSessionId).toStartWith("scripted-")
    const newWriter = Number(await fs.readFile(path.join(context.backend.directory, "writer.pid"), "utf8"))
    expect(newWriter).not.toBe(oldWriter)
    let oldAlive = true
    try { process.kill(oldWriter, 0) } catch { oldAlive = false }
    expect(oldAlive).toBe(false)
  } finally { await context.close() }
})

test("text an ACP agent streams before its prompt fails reaches the turn before the failure", async () => {
  const context = await setupConformance({
    name: "acp text before failure", backend: () => backend("process"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    await writeAcpScript(context.backend.directory, "partial", { steps: [
      { kind: "text", text: "Starting again.", chunks: 15 },
      { kind: "error", message: "You've reached your usage limit." },
    ] })
    const text: string[] = []
    const running = async () => {
      for await (const routed of context.transport.send(context.session, context.turn(acpScriptToken("partial")), context.turnBroker())) {
        if (routed.event.type === "text-delta") text.push(routed.event.delta)
      }
    }
    await expect(running()).rejects.toThrow("usage limit")
    expect(text.join("")).toBe("Starting again.")
  } finally { await context.close() }
})

test("the targeted red ACP agent fails at session/prompt", async () => {
  const context = await setupConformance({
    name: "acp red",
    backend: () => backend("process", "resume", true, undefined, true),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    const running = async () => {
      for await (const _event of context.transport.send(context.session,
        context.turn("This must fail in the scripted ACP agent"), context.turnBroker())) {}
    }
    expect(await rejectionMessage(running)).toContain("Scripted ACP red run")
    expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/prompt")).toBe(true)
  } finally { await context.close() }
})

test("a human permission wait suspends ACP's quiet deadline", async () => {
  let timers: FakeTimers | undefined
  const context = await setupConformance({
    name: "acp held permission",
    async backend() {
      const peer = await backend("websocket")
      return { ...peer, connection: { ...peer.connection, promptTimeoutMs: 100 } }
    },
    makeTransport(services, state) {
      timers = fakeClock(services)
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    const running = (async () => {
      const events = []
      for await (const event of context.transport.send(context.session,
        context.turn(context.backend.permissionCommand!), context.turnBroker())) events.push(event)
      return events
    })()
    const pending = await Promise.race([
      waitFor(() => context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission"), "permission request"),
      running.then(() => undefined),
    ])
    expect(pending).toBeDefined()
    expect(timers!.size).toBe(0)
    expect((await context.owner.broker.answer(pending!.request.requestId,
      { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
    expect((await running).some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
})

test("a startup elicitation suspends session/new and binds to its reservation", async () => {
  let owner: ReturnType<typeof import("../broker").createRequestBroker> | undefined
  let ports: import("./test-support/memory-ports").MemoryPorts | undefined
  let timers: FakeTimers | undefined
  const started = setupConformance({
    name: "acp startup question",
    async backend() {
      const peer = await backend("websocket", "resume", true, undefined, false, true)
      return { ...peer, connection: { ...peer.connection, startupTimeoutMs: 100 },
        onSetup(context) { owner = context.owner; ports = context.ports } }
    },
    makeTransport(services, state) {
      timers = fakeClock(services)
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  const pending = await Promise.race([
    waitFor(() => owner?.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "elicitation"), "startup elicitation"),
    started.then(() => undefined),
  ])
  expect(pending?.start).toEqual(ports?.startBinding)
  expect([...timers!.values()].filter((timer) => timer.ms === 100)).toEqual([])
  const answer = await owner!.broker.answer(pending!.request.requestId, { kind: "form", values: { answer: "yes" } },
    { start: ports!.startBinding! })
  expect(answer.ok).toBe(true)
  const context = await started
  try { expect(context.session.binding.upstreamSessionId).toStartWith("scripted-") }
  finally { await context.close() }
})

test("a draft ACP probe cancels startup questions, deduplicates, and retires its process", async () => {
  const state = await backend("process", "resume", true, undefined, false, true)
  const services = createTestServices()
  const transport = new AcpTransport(services, state.connection, filterMcpServers)
  const draft = { workspaceId: "w1", directory: state.directory, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  try {
    expect(await transport.config.options({ draft }, "peek")).toEqual({ options: [] })
    const [first, second] = await Promise.all([
      transport.config.options({ draft }, "probe"), transport.config.options({ draft }, "probe"),
    ])
    expect(first).toEqual(second)
    expect(first.options.some((item) => item.id === "mode")).toBe(true)
    expect(await transport.config.options({ draft }, "probe")).toEqual(first)
    expect(await transport.config.options({ draft }, "peek")).toEqual(first)
    expect((await transport.config.permissionModes({ draft })).modes.map((mode) => mode.id)).toEqual(["default", "review"])
    const requests = await readAcpRequests(state.directory)
    expect(requests.filter((row) => row.method === "session/new")).toHaveLength(1)
    expect(requests.find((row) => row.method === "startup/answer")?.params).toMatchObject({ action: "cancel" })
    expect(services.processes).toHaveLength(1)
    expect(await services.processes[0]!.exited).toBeDefined()
  } finally { await transport.dispose(); await state.close() }
})

test("ACP child catalog updates leave the parent commands and options intact", async () => {
  const context = await setupConformance({
    name: "acp child catalog", backend: () => backend("process"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const entry = (context.transport as unknown as { entries: Map<string, AcpEntry> }).entries.get("s1")!
    const commands = entry.commands
    const options = entry.options
    const sessionId = `child-of-${context.session.binding.upstreamSessionId}`
    await acpUpdate(entry, { sessionId, update: { sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "child-only", description: "Child command" }] } })
    await acpUpdate(entry, { sessionId, update: { sessionUpdate: "config_option_update", configOptions: [] } })
    expect(entry.commands).toEqual(commands)
    expect(entry.options).toEqual(options)
  } finally { await context.close() }
})

test("ACP failed cancellation makes an active turn uncertain", async () => {
  const context = await setupConformance({
    name: "acp failed cancellation", backend: () => backend("process"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const entry = (context.transport as unknown as { entries: Map<string, AcpEntry> }).entries.get("s1")!
    entry.peer.agent.cancel = async () => { throw new Error("cancel refused") }
    const running = (async () => {
      for await (const _event of context.transport.send(context.session,
        context.turn(acpScriptToken("silence")), context.turnBroker())) {}
    })()
    const settled = running.then(() => undefined, (error: unknown) => error)
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/prompt")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const result = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" },
      { at: Date.now() + 5_000, signal: new AbortController().signal })
    expect(result.error?.message).toContain("cancel refused")
    expect((await settled as Error).message).toContain("outcome is uncertain")
  } finally { await context.close() }
})

test("ACP abort handles rejected cancellation and releases the turn", async () => {
  const context = await setupConformance({
    name: "acp failed abort", backend: () => backend("process"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const entry = (context.transport as unknown as { entries: Map<string, AcpEntry> }).entries.get("s1")!
    entry.peer.agent.cancel = async () => { throw new Error("abort cancel refused") }
    const controller = new AbortController()
    const running = (async () => {
      for await (const _event of context.transport.send(context.session,
        context.turn(acpScriptToken("silence")), context.turnBroker(controller.signal))) {}
    })()
    const settled = running.then(() => undefined, (error: unknown) => error)
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/prompt")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    controller.abort()
    const outcome = await Promise.race([
      settled,
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 2_000)),
    ])
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain("outcome is uncertain")
    expect(entry.phase).toBe("uncertain")
  } finally { await context.close() }
})

test("ACP draft probe cache excludes credentials, keeps an answer for its launch identity for 30 seconds, and probes again for a new projection or lease", async () => {
  const state = await backend("process")
  const services = createTestServices()
  let elapsed = 0
  services.clock.now = () => Date.now() + elapsed
  const transport = new AcpTransport(services, state.connection, filterMcpServers)
  const draft = { workspaceId: "w1", directory: state.directory, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model,
    credentials: { ...state.credentials, secrets: { API_KEY: "probe-secret-sentinel" } },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  try {
    await transport.config.options({ draft }, "probe")
    const probes = (transport as unknown as { probes: { cache: Map<string, unknown> } }).probes
    expect([...probes.cache.keys()].join(" ")).not.toContain("probe-secret-sentinel")
    await transport.config.options({ draft }, "probe")
    expect((await readAcpRequests(state.directory)).filter((row) => row.method === "session/new")).toHaveLength(1)
    elapsed = 30_000
    expect((await transport.config.options({ draft }, "peek")).options).toEqual([])
    await transport.config.options({ draft }, "probe")
    expect((await readAcpRequests(state.directory)).filter((row) => row.method === "session/new")).toHaveLength(2)
    await transport.config.options({ draft: { ...draft, workspaceId: "w2" } }, "probe")
    await transport.config.options({ draft: { ...draft, projection: { ...draft.projection, generation: "g2" } } }, "probe")
    await transport.config.options({ draft: { ...draft, credentials: { ...draft.credentials, leaseGeneration: "rotated" } } }, "probe")
    expect(probes.cache.size).toBe(4)
    expect((await readAcpRequests(state.directory)).filter((row) => row.method === "session/new")).toHaveLength(5)
  } finally { await transport.dispose(); await state.close() }
})

test("ACP HTTP retirement closes a connection with a write in flight", async () => {
  const fetchRequest = globalThis.fetch
  let hold = false
  let deletes = 0
  let entered!: () => void
  let release!: () => void
  const writing = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = ((input, init) => {
    if (init?.method === "DELETE") return fetchRequest(input, init).then((response) => { deletes++; return response })
    if (hold && init?.method === "POST") {
      entered()
      return held.then(() => fetchRequest(input, init))
    }
    return fetchRequest(input, init)
  }) as typeof fetch
  let context: Awaited<ReturnType<typeof setupConformance>> | undefined
  try {
    context = await setupConformance({
      name: "acp HTTP write retirement", backend: () => backend("streamable-http", "resume", true, undefined, false, false, ["agents"]),
      makeTransport(services, state) {
        return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
      },
    })
    hold = true
    const listing = context.transport.agents!.list({ session: context.session })
    void listing.then(undefined, () => undefined)
    await writing
    await expect(context.transport.dispose()).resolves.toBeUndefined()
    expect(deletes).toBe(1)
    await expect(listing).rejects.toThrow()
  } finally {
    release()
    globalThis.fetch = fetchRequest
    await context?.close()
  }
})

test("a failed ACP draft probe retires and can be retried", async () => {
  const state = await backend("process", "resume", true, "session/new")
  const services = createTestServices()
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let nextTimer = 0
  services.clock = { now: () => Date.now(), setTimeout(callback, ms) {
    const id = ++nextTimer
    timers.set(id, { callback, ms })
    return id
  }, clearTimeout(handle) { timers.delete(handle as number) } }
  const transport = new AcpTransport(services, { ...state.connection, startupTimeoutMs: 100 }, filterMcpServers)
  const draft = { workspaceId: "w1", directory: state.directory, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  try {
    for (let count = 1; count <= 2; count++) {
      const probe = transport.config.options({ draft }, "probe")
      for (let attempt = 0; attempt < 500; attempt++) {
        if ((await readAcpRequests(state.directory)).filter((row) => row.method === "session/new").length === count) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect((await readAcpRequests(state.directory)).filter((row) => row.method === "session/new")).toHaveLength(count)
      expect([...timers.values()].map((timer) => timer.ms)).toEqual([100])
      timers.values().next().value!.callback()
      await expect(probe).rejects.toThrow("draft probe timed out")
    }
    expect(services.processes).toHaveLength(2)
    expect(await Promise.all(services.processes.map((process) => process.exited))).toHaveLength(2)
  } finally { await transport.dispose(); await state.close() }
})

test("disposing ACP during a startup ask persists cancellation before process retirement", async () => {
  const state = await backend("process", "resume", true, undefined, false, true)
  const services = createTestServices()
  const ports = new MemoryPorts()
  const start = { sessionId: "s1", workspaceId: "w1", directory: state.directory,
    connectionId: "scripted-acp", operationId: "start-1" }
  ports.startBinding = start
  ports.directories.set("s1", state.directory)
  const owner = createRequestBroker(ports)
  const broker = createSessionBroker(owner, { ...start, start, origin })
  const transport = new AcpTransport(services, state.connection, filterMcpServers)
  const input = { ...start, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  try {
    const starting = transport.start(input, broker)
    let pending = owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "elicitation")
    for (let attempt = 0; !pending && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      pending = owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "elicitation")
    }
    expect(pending).toBeDefined()
    await transport.dispose()
    await expect(starting).rejects.toThrow()
    expect(ports.readAnswer("s1", pending!.request.requestId)).toEqual({ kind: "cancelled" })
    expect(await owner.broker.answer(pending!.request.requestId, { kind: "rejected" }, { start })).toMatchObject({ refusal: "stale" })
    expect(await services.processes[0]!.exited).toBeDefined()
  } finally { await transport.dispose(); await state.close() }
})

test("concurrent ACP starts own distinct pre-ID questions and refuse another binding", async () => {
  const state = await backend("websocket", "resume", true, undefined, false, true)
  const services = createTestServices()
  const ports = new MemoryPorts()
  const first = { sessionId: "s1", workspaceId: "w1", directory: state.directory,
    connectionId: "scripted-acp", operationId: "start-1" }
  const second = { ...first, sessionId: "s2", workspaceId: "w2", operationId: "start-2" }
  ports.readStart = (sessionId) => {
    const binding = sessionId === "s1" ? first : sessionId === "s2" ? second : undefined
    return binding ? { binding, status: "starting", createdAt: 1, updatedAt: 1 } : undefined
  }
  ports.current.set("s1", { ...authority, directory: state.directory })
  ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2", directory: state.directory })
  ports.directories.set("s1", state.directory)
  ports.directories.set("s2", state.directory)
  const owner = createRequestBroker(ports)
  const transport = new AcpTransport(services, state.connection, filterMcpServers)
  const base = { directory: state.directory, locality: "remote" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  try {
    const startingFirst = transport.start({ ...base, ...first }, createSessionBroker(owner, { ...first, start: first, origin }))
    const startingSecond = transport.start({ ...base, ...second }, createSessionBroker(owner, { ...second, start: second, origin }))
    let questions = owner.broker.list({ directory: state.directory }).filter((row) => row.request.kind === "elicitation")
    for (let attempt = 0; questions.length < 2 && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      questions = owner.broker.list({ directory: state.directory }).filter((row) => row.request.kind === "elicitation")
    }
    expect(questions).toHaveLength(2)
    const firstQuestion = questions.find((row) => row.sessionId === "s1")!
    const secondQuestion = questions.find((row) => row.sessionId === "s2")!
    expect(firstQuestion.start).toEqual(first)
    expect(secondQuestion.start).toEqual(second)
    expect(await owner.broker.answer(firstQuestion.request.requestId,
      { kind: "form", values: { answer: "wrong" } }, { start: second })).toMatchObject({ refusal: "foreign" })
    expect(await owner.broker.answer(secondQuestion.request.requestId,
      { kind: "form", values: { answer: "wrong" } }, { start: first })).toMatchObject({ refusal: "foreign" })
    expect((await owner.broker.answer(firstQuestion.request.requestId,
      { kind: "form", values: { answer: "first" } }, { start: first })).ok).toBe(true)
    expect((await owner.broker.answer(secondQuestion.request.requestId,
      { kind: "form", values: { answer: "second" } }, { start: second })).ok).toBe(true)
    expect((await Promise.all([startingFirst, startingSecond])).map((session) => session.binding.upstreamSessionId))
      .toEqual([expect.stringMatching(/^scripted-/), expect.stringMatching(/^scripted-/)])
    expect(ports.saved.map((row) => row.pending.sessionId).sort()).toEqual(["s1", "s2"])
  } finally { await transport.dispose(); await state.close() }
})

test("simultaneous ACP initializations keep their reservation questions separate", async () => {
  const state = await backend("process")
  const services = createTestServices()
  const ports = new MemoryPorts()
  const first = { sessionId: "s1", workspaceId: "w1", directory: state.directory,
    connectionId: "scripted-acp", operationId: "init-1" }
  const second = { ...first, sessionId: "s2", workspaceId: "w2", operationId: "init-2" }
  ports.readStart = (sessionId) => {
    const binding = sessionId === "s1" ? first : sessionId === "s2" ? second : undefined
    return binding ? { binding, status: "starting", createdAt: 1, updatedAt: 1 } : undefined
  }
  ports.current.set("s1", { ...authority, directory: state.directory })
  ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2", directory: state.directory })
  ports.directories.set("s1", state.directory)
  ports.directories.set("s2", state.directory)
  const owner = createRequestBroker(ports)
  const transport = new AcpTransport(services, { kind: "process", command: process.execPath,
    args: [path.join(import.meta.dirname, "../../e2e/harness/acp/startup-agent.ts")],
    env: { SCRIPTED_ACP_DIR: state.directory, SCRIPTED_ACP_INIT_QUESTION: "1", SCRIPTED_ACP_SKIP_NEW_QUESTION: "1" } },
  filterMcpServers)
  const base = { directory: state.directory, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  try {
    const startingFirst = transport.start({ ...base, ...first }, createSessionBroker(owner, { ...first, start: first, origin }))
    const startingSecond = transport.start({ ...base, ...second }, createSessionBroker(owner, { ...second, start: second, origin }))
    let questions = owner.broker.list({ directory: state.directory }).filter((row) => row.request.kind === "elicitation")
    for (let attempt = 0; questions.length < 2 && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      questions = owner.broker.list({ directory: state.directory }).filter((row) => row.request.kind === "elicitation")
    }
    expect(questions).toHaveLength(2)
    expect(questions.map((row) => row.start?.operationId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["init-1", "init-2"])
    for (const row of questions) {
      const binding = row.sessionId === "s1" ? first : second
      expect((await owner.broker.answer(row.request.requestId,
        { kind: "form", values: { answer: row.sessionId } }, { start: binding })).ok).toBe(true)
    }
    expect((await Promise.all([startingFirst, startingSecond])).map((session) => session.binding.upstreamSessionId))
      .toEqual([expect.stringMatching(/^scripted-startup-/), expect.stringMatching(/^scripted-startup-/)])
  } finally { await transport.dispose(); await state.close() }
})

test("silence cancels the ACP prompt and fences its uncertain session", async () => {
  const context = await setupConformance({
    name: "acp silence",
    async backend() {
      const peer = await backend("websocket")
      return { ...peer, connection: { ...peer.connection, promptTimeoutMs: 100 } }
    },
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    const run = async (message: string) => {
      for await (const _event of context.transport.send(context.session, context.turn(message), context.turnBroker())) {}
    }
    expect(await rejectionMessage(() => run(acpScriptToken("silence")))).toContain("outcome is uncertain")
    expect(await rejectionMessage(() => run("next prompt"))).toContain("outcome is uncertain")
    let requests = await readAcpRequests(context.backend.directory)
    for (let attempt = 0; !requests.some((row) => row.method === "session/cancel") && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      requests = await readAcpRequests(context.backend.directory)
    }
    expect(requests.some((row) => row.method === "session/prompt")).toBe(true)
    expect(requests.some((row) => row.method === "session/cancel")).toBe(true)
  } finally { await context.close() }
})

test("a held ACP permission rejects a second turn on its session while a sibling runs", async () => {
  const context = await setupConformance({
    name: "acp same-session admission", backend: () => backend("websocket"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const running = (async () => {
      const events = []
      for await (const event of context.transport.send(context.session,
        context.turn(context.backend.permissionCommand!), context.turnBroker())) events.push(event)
      return events
    })()
    let pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    for (let attempt = 0; !pending && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    }
    expect(pending).toBeDefined()
    const duplicate = async () => {
      for await (const _event of context.transport.send(context.session, context.turn("duplicate"), context.turnBroker())) {}
    }
    await expect(duplicate()).rejects.toThrow("active turn")
    context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2" })
    context.ports.directories.set("s2", context.backend.directory)
    const sibling = await context.transport.start({ ...context.start, sessionId: "s2", workspaceId: "w2" },
      createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w2", directory: context.backend.directory, origin }))
    const siblingBroker = createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!, origin,
      signal: new AbortController().signal })
    const siblingEvents = []
    for await (const event of context.transport.send(sibling, context.turn(acpScriptToken("text")), siblingBroker)) siblingEvents.push(event)
    expect(siblingEvents.some((item) => item.event.type === "finish")).toBe(true)
    expect((await context.owner.broker.answer(pending!.request.requestId,
      { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
    expect((await running).some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
})

test("an immediate ACP permission answer releases the quiet hold and leaves an uncertain turn fenced", async () => {
  const context = await setupConformance({
    name: "acp answered hold", backend: () => backend("websocket"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  context.services.clock = { now: () => Date.now(), setTimeout(callback) {
    const id = ++nextTimer
    timers.set(id, callback)
    return id
  }, clearTimeout(handle) { timers.delete(handle as number) } }
  try {
    const running = (async () => {
      for await (const _event of context.transport.send(context.session,
        context.turn(acpScriptToken("permission-silence")), context.turnBroker())) {}
    })()
    let pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    for (let attempt = 0; !pending && attempt < 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
    }
    expect(pending).toBeDefined()
    expect(timers.size).toBe(0)
    expect((await context.owner.broker.answer(pending!.request.requestId,
      { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
    for (let attempt = 0; timers.size === 0 && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(timers.size).toBe(1)
    timers.values().next().value!()
    await expect(running).rejects.toThrow("outcome is uncertain")
    const retry = async () => {
      for await (const _event of context.transport.send(context.session, context.turn("retry"), context.turnBroker())) {}
    }
    await expect(retry()).rejects.toThrow("outcome is uncertain")
  } finally { await context.close() }
})

test("disposing ACP rejects an active prompt", async () => {
  const context = await setupConformance({
    name: "acp in-flight disposal", backend: () => backend("websocket"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const running = (async () => {
      for await (const _event of context.transport.send(context.session,
        context.turn(acpScriptToken("silence")), context.turnBroker())) {}
    })()
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/prompt")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await context.transport.dispose()
    await expect(running).rejects.toThrow()
  } finally { await context.close() }
})

test("a stalled ACP resume times out without disturbing a sibling peer", async () => {
  const context = await setupConformance({
    name: "acp stalled resume", backend: () => backend("websocket", "resume", true, "session/resume"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    await context.transport.close(context.session)
    context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2" })
    context.ports.directories.set("s2", context.backend.directory)
    const sibling = await context.transport.start({ ...context.start, sessionId: "s2", workspaceId: "w2" },
      createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w2", directory: context.backend.directory, origin }))
    const timers = new Map<number, () => void>()
    let nextTimer = 0
    context.services.clock = { now: () => Date.now(), setTimeout(callback) {
      const id = ++nextTimer
      timers.set(id, callback)
      return id
    }, clearTimeout(handle) { timers.delete(handle as number) } }
    const attaching = context.transport.attach({ ...context.start, binding: context.session.binding, upstreamHasTurns: false }, context.sessionBroker)
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume")).toBe(true)
    expect(timers.size).toBe(1)
    timers.values().next().value!()
    await expect(attaching).rejects.toThrow("session restore timed out")
    expect(context.transport.health?.connection(context.backend.directory, "s1").state).toBe("failed")
    expect(context.transport.health?.connection(context.backend.directory, "s2").state).toBe("ready")
    const siblingBroker = createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!, origin,
      signal: new AbortController().signal })
    const events = []
    for await (const event of context.transport.send(sibling, context.turn(acpScriptToken("text")), siblingBroker)) events.push(event)
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
})

test("a timed-out ACP config restore quarantines that session while its sibling survives", async () => {
  const context = await setupConformance({
    name: "acp config restore quarantine", backend: () => backend("websocket", "resume", true, "session/resume"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2" })
    context.ports.directories.set("s2", context.backend.directory)
    const sibling = await context.transport.start({ ...context.start, sessionId: "s2", workspaceId: "w2" },
      createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w2", directory: context.backend.directory, origin }))
    const timers = new Map<number, () => void>()
    let nextTimer = 0
    context.services.clock = { now: () => Date.now(), setTimeout(callback) {
      const id = ++nextTimer
      timers.set(id, callback)
      return id
    }, clearTimeout(handle) { timers.delete(handle as number) } }
    const restarting = context.transport.configure(context.session,
      { projection: { ...context.start.projection, generation: "plugins:changed" } })
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(timers.size).toBe(1)
    timers.values().next().value!()
    await expect(restarting).rejects.toThrow("session restore timed out")
    expect(context.transport.health?.connection(context.backend.directory, "s1").state).toBe("failed")
    expect(context.transport.health?.connection(context.backend.directory, "s2").state).toBe("ready")
    const refused = async () => {
      for await (const _event of context.transport.send(context.session, context.turn("refused"), context.turnBroker())) {}
    }
    await expect(refused()).rejects.toThrow("ACP session restart failed: ACP session restore timed out")
    await expect(context.transport.close(context.session)).resolves.toBeUndefined()
    const siblingBroker = createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!, origin,
      signal: new AbortController().signal })
    const events = []
    for await (const event of context.transport.send(sibling, context.turn(acpScriptToken("text")), siblingBroker)) events.push(event)
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
})

test("ACP child updates use a child route and brokered lineage", async () => {
  const context = await setupConformance({
    name: "acp child",
    backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    const events = []
    for await (const event of context.transport.send(context.session,
      context.turn(acpScriptToken("subagent")), context.turnBroker())) events.push(event)
    expect(context.ports.childEvents.some(({ event: item }) => item.route?.kind === "child" && item.event.type === "text-delta" && item.event.delta.includes("Child result"))).toBe(true)
    expect(events.some((item) => item.route?.kind === "child")).toBe(false)
    expect(context.ports.subagents.some((item) => item.status === "running")).toBe(true)
    expect(context.ports.subagents.some((item) => item.status === "completed")).toBe(true)
  } finally { await context.close() }
})

test("ACP prompt-result usage reaches the turn as a cumulative observation before it finishes", async () => {
  const context = await setupConformance({
    name: "acp usage",
    backend: () => backend("process"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers)
    },
  })
  try {
    const events = []
    for await (const item of context.transport.send(context.session, context.turn(acpScriptToken("usage")), context.turnBroker())) {
      events.push(item.event)
    }
    const usage = events.findIndex((event) => event.type === "usage" && event.observation !== undefined)
    expect(usage).toBeGreaterThanOrEqual(0)
    expect(usage).toBeLessThan(events.findIndex((event) => event.type === "finish"))
    expect(events[usage]).toEqual({
      type: "usage", contextSize: 0, contextUsed: 0,
      observation: { kind: "cumulative", nativeSessionId: context.session.binding.upstreamSessionId,
        tokens: { input: 11, output: 5, reasoning: 2, cache: { read: 1, write: 0 } } },
    })
  } finally { await context.close() }
})

runConformance({
  name: "acp websocket without MCP support",
  backend: () => backend("websocket", "resume", false),
  makeTransport(services, state) {
    const peer = state as AcpBackend
    return new AcpTransport(services, peer.connection, filterMcpServers)
  },
})

for (const group of ["steer", "agents", "goals"] as const) {
  for (const present of [true, false]) {
    test(`ACP scripted handshake ${present ? "declares" : "omits"} ${group}`, async () => {
      const context = await setupConformance({
        name: `acp ${group} ${present}`,
        backend: () => backend("websocket", "resume", true, undefined, false, false, present ? [group] : []),
        makeTransport(services, state) {
          return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
        },
      })
      try {
        const caps = await context.transport.capabilities({ directory: context.backend.directory, sessionId: "s1" })
        if (group === "steer") {
          expect(context.transport.steer !== undefined).toBe(present)
          if (present) {
            const running = (async () => {
              for await (const _event of context.transport.send(context.session,
                context.turn(context.backend.permissionCommand!), context.turnBroker())) {}
            })()
            let pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
            for (let attempt = 0; !pending && attempt < 500; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 10))
              pending = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission")
            }
            expect(pending).toBeDefined()
            expect(await context.transport.steer?.steer(context.session, { turnId: "t1", assistantMessageId: "a1" },
              context.turn("Follow this steer"))).toEqual({ ok: true })
            expect((await context.owner.broker.answer(pending!.request.requestId,
              { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
            await running
          }
        } else if (group === "agents") {
          const listed = await context.transport.agents!.list({ session: context.session })
          expect(listed).toEqual(present
            ? [{ name: "default", description: "Default", mode: "primary" }, { name: "review", description: "Review", mode: "primary" }]
            : [{ name: "default", description: "Default", mode: "primary" }, { name: "review", description: "Review", mode: "primary" }])
          expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/agents/list")).toBe(present)
        } else {
          expect(caps.goals.available).toBe(present)
          expect(context.transport.goals !== undefined).toBe(present)
          if (present) {
            expect(await context.transport.goals?.read(context.session)).toBeNull()
            expect(await context.transport.goals?.start(context.session, "Ship the change", context.sessionBroker))
              .toMatchObject({ ok: true, goal: { sessionId: "s1", status: "active" } })
          }
        }
      } finally { await context.close() }
    })
  }
}

type FakeTimers = Map<number, { callback: () => void; ms: number }>

function fakeClock(services: { clock: ReturnType<typeof createTestServices>["clock"] }): FakeTimers {
  const timers: FakeTimers = new Map()
  let next = 0
  services.clock = { now: () => Date.now(), setTimeout(callback, ms) {
    const id = ++next
    timers.set(id, { callback, ms })
    return id
  }, clearTimeout(handle) { timers.delete(handle as number) } }
  return timers
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, label: string, attempts = 500): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${label} did not happen`)
}

async function deferredRestartFailure(context: Awaited<ReturnType<typeof setupConformance>>, script: string) {
  const timers = fakeClock(context.services)
  const running = (async () => {
    const events = []
    for await (const event of context.transport.send(context.session, context.turn(acpScriptToken(script)), context.turnBroker())) events.push(event)
    return events
  })()
  const settled = running.then((events) => ({ kind: "events" as const, events }), (error: unknown) => ({ kind: "error" as const, error }))
  const pending = await waitFor(() => context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission"), "permission")
  expect(await context.transport.configure(context.session, { projection: { ...context.start.projection, generation: "plugins:rotated" } }))
    .toEqual({ state: "deferred", until: "after-active-turns" })
  expect((await context.owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
  const outcome = await Promise.race([settled, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 3_000))])
  await waitFor(async () => (await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume") || undefined, "session/resume")
  const restore = [...timers.values()].filter((timer) => timer.ms === 10_000).at(-1)
  expect(restore).toBeDefined()
  restore!.callback()
  const failure = await waitFor(() => context.ports.failures[0], "reported restart failure")
  expect(String(failure)).toContain("session restore timed out")
  const refused = async () => {
    for await (const _event of context.transport.send(context.session, context.turn("after failed restart"), context.turnBroker())) {}
  }
  await expect(refused()).rejects.toThrow("ACP session restart failed: ACP session restore timed out")
  return outcome
}

test("a completed turn stays completed when its deferred ACP restart fails", async () => {
  const context = await setupConformance({
    name: "acp deferred restart after completion", backend: () => backend("websocket", "resume", true, "session/resume"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const outcome = await deferredRestartFailure(context, "permission")
    expect(outcome).not.toBe("pending")
    expect(outcome).toMatchObject({ kind: "events" })
    if (outcome !== "pending" && outcome.kind === "events") expect(outcome.events.some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 30_000)

test("a failed turn keeps its own error when its deferred ACP restart fails", async () => {
  const context = await setupConformance({
    name: "acp deferred restart after failure", backend: () => backend("websocket", "resume", true, "session/resume"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const outcome = await deferredRestartFailure(context, "permission-refused")
    expect(outcome).not.toBe("pending")
    expect(outcome).toMatchObject({ kind: "error" })
    if (outcome !== "pending" && outcome.kind === "error") expect(String(outcome.error)).toContain("Scripted ACP refused after permission")
  } finally { await context.close() }
}, 30_000)

test("an ACP Stop after an idle cancel still reaches the agent", async () => {
  const context = await setupConformance({
    name: "acp stale cancel", backend: () => backend("websocket"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    for await (const _event of context.transport.send(context.session, context.turn(acpScriptToken("text")), context.turnBroker())) {}
    const idle = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 5_000, signal: new AbortController().signal })
    expect(idle).toEqual({ execution: "terminal", cleanup: "unknown" })
    expect((await readAcpRequests(context.backend.directory)).filter((row) => row.method === "session/cancel")).toHaveLength(0)
    const running = (async () => {
      const events = []
      for await (const event of context.transport.send(context.session, context.turn(acpScriptToken("silence")), context.turnBroker())) events.push(event)
      return events
    })()
    await waitFor(async () => (await readAcpRequests(context.backend.directory)).filter((row) => row.method === "session/prompt").length === 2 || undefined, "second prompt")
    const stopped = await context.transport.cancel(context.session, { turnId: "t2", assistantMessageId: "a2" }, { at: Date.now() + 5_000, signal: new AbortController().signal })
    expect(stopped.error).toBeUndefined()
    await waitFor(async () => (await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/cancel") || undefined, "session/cancel", 200)
    expect((await running).some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 30_000)

test("an ACP cancel honors its deadline while an HTTP write hangs", async () => {
  const fetchRequest = globalThis.fetch
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let heldCancels = 0
  globalThis.fetch = ((input, init) => {
    if (init?.method === "POST" && typeof init.body === "string" && init.body.includes("session/cancel")) {
      heldCancels++
      return held.then(() => fetchRequest(input, init))
    }
    return fetchRequest(input, init)
  }) as typeof fetch
  let context: Awaited<ReturnType<typeof setupConformance>> | undefined
  try {
    context = await setupConformance({
      name: "acp bounded cancel", backend: () => backend("streamable-http"),
      makeTransport(services, state) {
        return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
      },
    })
    const running = (async () => {
      for await (const _event of context.transport.send(context.session, context.turn(acpScriptToken("silence")), context.turnBroker())) {}
    })()
    const settled = running.then(() => "completed", (error: unknown) => String(error))
    const directory = context.backend.directory
    await waitFor(async () => (await readAcpRequests(directory)).some((row) => row.method === "session/prompt") || undefined, "session/prompt")
    const outcome = await Promise.race([
      context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 300, signal: new AbortController().signal }),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 3_000)),
    ])
    expect(outcome).not.toBe("pending")
    expect(outcome).toMatchObject({ execution: "unknown", error: { code: "provider_unreachable" } })
    if (outcome !== "pending") expect(outcome.error?.message).toContain("session/cancel timed out")
    expect(heldCancels).toBe(1)
    expect(await Promise.race([settled, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 3_000))])).toContain("outcome is uncertain")
  } finally {
    release()
    globalThis.fetch = fetchRequest
    await context?.close()
  }
}, 30_000)

test("an ACP agent without plugin intake receives MCP servers and a not-applied report", async () => {
  const context = await setupConformance({
    name: "acp plugins not applied",
    async backend() {
      const state = await backend("process")
      return { ...state, projection: { generation: "g1", notApplied: [],
        pluginRoots: [{ pluginInstanceId: "plugin-one", root: path.join(state.root, "plugin"), skillNames: [], dataRoot: path.join(state.root, "plugin-data") }],
        mcpServers: [{ kind: "http" as const, name: "plugin-http", url: "http://127.0.0.1:47357/mcp", origin: "plugin" as const }] } }
    },
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers)
    },
  })
  try {
    const created = (await readAcpRequests(context.backend.directory)).find((row) => row.method === "session/new")
    expect((created!.params.mcpServers as { name: string }[]).map((server) => server.name)).toEqual(["plugin-http"])
    expect(created?.params._meta).toBeUndefined()
    const notice = context.ports.sessionEvents.find((row) => (row.event as { type?: string }).type === "harness-notice")
    expect(notice?.event).toMatchObject({ code: "acp.plugins.not-applied", severity: "warn",
      message: "Plugin plugin-one not applied: this ACP agent accepts MCP servers only",
      details: { notApplied: [{ item: "plugin-one", reason: "unsupported-by-harness" }] } })
  } finally { await context.close() }
}, 30_000)

const PARITY_ACP_AGENT = `const { agent, ndJsonStream, PROTOCOL_VERSION } = await import(process.env.ACP_SDK)
const fs = await import("node:fs")
const { Readable, Writable } = await import("node:stream")
const log = (method, params) => fs.appendFileSync(process.env.PARITY_ACP_LOG, JSON.stringify({ method, params }) + "\\n")
const flag = (name) => process.env[name] === "1"
const caps = JSON.parse(process.env.PARITY_ACP_PROMPT_CAPS ?? '{"image":true,"embeddedContext":true}')
const agentInfo = process.env.PARITY_ACP_AGENT_INFO ? JSON.parse(process.env.PARITY_ACP_AGENT_INFO) : { name: "parity-acp", version: "1.0.0" }
const state = { mode: "default", model: "scripted/alpha", effort: "low" }
const modes = () => ({ currentModeId: state.mode, availableModes: [{ id: "default", name: "Default" }, { id: "review", name: "Review" }] })
const options = () => [
  { id: "mode", name: "Agent", category: "mode", type: "select", currentValue: state.mode, options: [{ value: "default", name: "Default" }, { value: "review", name: "Review" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model, options: [{ value: "scripted/alpha", name: "Alpha" }, { value: "scripted/beta", name: "Beta" }] },
  { id: "thought_level", name: "Effort", category: "thought_level", type: "select", currentValue: state.effort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
]
let sessions = 0
let releasePrompt
agent()
  .onRequest("initialize", async () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo, authMethods: [],
    agentCapabilities: { loadSession: true, promptCapabilities: caps, mcpCapabilities: { http: true, sse: true } } }))
  .onRequest("session/new", async (context) => {
    log("session/new", context.params)
    const sessionId = "parity-" + (++sessions)
    return flag("PARITY_ACP_MODES_ONLY") ? { sessionId, modes: modes() } : { sessionId, configOptions: options() }
  })
  .onRequest("session/set_config_option", async (context) => {
    log("session/set_config_option", context.params)
    const { configId, value } = context.params
    if (configId === "mode") state.mode = value
    if (configId === "mode") releasePrompt?.()
    if (configId === "model" && !flag("PARITY_ACP_CLAMP_MODEL")) state.model = value
    if (configId === "thought_level") state.effort = value
    if (configId === "thought_level" && flag("PARITY_ACP_HOLD_FOR_SETTINGS")) releasePrompt?.()
    return { configOptions: options() }
  })
  .onRequest("session/set_mode", async (context) => {
    log("session/set_mode", context.params)
    if (!flag("PARITY_ACP_CLAMP_MODE")) state.mode = context.params.modeId
    releasePrompt?.()
    await context.client.notify("session/update", { sessionId: context.params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: state.mode } })
    return {}
  })
  .onRequest("session/prompt", async (context) => {
    log("session/prompt", context.params)
    if (flag("PARITY_ACP_HOLD_FOR_MODE") || flag("PARITY_ACP_HOLD_FOR_SETTINGS")) await new Promise((resolve) => { releasePrompt = resolve })
    const text = context.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\\n")
    const reply = flag("PARITY_ACP_HOLD_FOR_SETTINGS") ? state.model + ":" + state.effort : flag("PARITY_ACP_HOLD_FOR_MODE") ? state.mode : text.includes(process.env.PARITY_ACP_TITLE_MARK ?? "\\u0000") ? "Scripted parity title" : "PARITY_OK"
    await context.client.notify("session/update", { sessionId: context.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } })
    return { stopReason: "end_turn" }
  })
  .onNotification("session/cancel", () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`

type ParityRequest = { method: string; params: Record<string, unknown> }
type ParityBackend = AcpBackend & { requests(): Promise<ParityRequest[]> }

async function parityBackend(env: Record<string, string> = {}, connection: { sharedFilesystem?: boolean } = {}): Promise<ParityBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-parity-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  const script = path.join(root, "parity-agent.mjs")
  await fs.writeFile(script, PARITY_ACP_AGENT)
  const log = path.join(root, "parity-requests.jsonl")
  return {
    root, directory, locality: "local", harness: { id: "parity-acp", access: "connection" },
    model: { providerID: "scripted", modelID: "default" }, owner: { kind: "machine-owner" },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "conformance" },
    connection: { kind: "process", command: process.execPath, args: [script], ...connection,
      env: { ACP_SDK: import.meta.resolve("@agentclientprotocol/sdk"), PARITY_ACP_LOG: log, ...env } },
    unrunnableTurn: (turn) => turn,
    requests: async () => (await fs.readFile(log, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
      throw error
    })).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ParityRequest),
    close: async () => { await removeTempRoot(root) },
  }
}

function parityTransport(services: ReturnType<typeof createTestServices>, state: ConformanceBackend) {
  return new AcpTransport(services, (state as ParityBackend).connection, filterMcpServers)
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
const TEXT_BASE64 = Buffer.from("ACP parity text attachment\n").toString("base64")
const WAV_BASE64 = Buffer.from("RIFF....WAVEfmt ").toString("base64")

function attachedTurn(turn: TurnInputLike, parts: TurnInputLike["prompt"]["parts"]): TurnInputLike {
  return { ...turn, prompt: { ...turn.prompt, parts: [...turn.prompt.parts, ...parts] } }
}

type TurnInputLike = ReturnType<Awaited<ReturnType<typeof setupConformance>>["turn"]>

test("claude-agent-acp receives plugin roots through its claudeCode options", async () => {
  const context = await setupConformance({
    name: "acp claude plugins",
    async backend() {
      const state = await parityBackend({ PARITY_ACP_AGENT_INFO: JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.81.2" }) })
      return { ...state, projection: { generation: "g1", notApplied: [], mcpServers: [],
        pluginRoots: [{ pluginInstanceId: "plugin-one", root: path.join(state.root, "plugin"), skillNames: [], dataRoot: path.join(state.root, "plugin-data") }] } }
    },
    makeTransport: parityTransport,
  })
  try {
    const created = (await (context.backend as ParityBackend).requests()).find((row) => row.method === "session/new")
    expect(created?.params._meta).toEqual({ claudeCode: { options: { plugins: [{ type: "local", path: path.join((context.backend as ParityBackend).root, "plugin") }] } } })
    expect(context.ports.sessionEvents.some((row) => (row.event as { type?: string }).type === "harness-notice")).toBe(false)
  } finally { await context.close() }
}, 30_000)

test("ACP applies the turn's permission mode, model and effort through set_config_option before the prompt", async () => {
  const context = await setupConformance({ name: "acp turn sync", backend: () => parityBackend(), makeTransport: parityTransport })
  try {
    const turn = { ...context.turn("Reply with exactly this one token: PARITY_OK"), model: { providerID: "scripted", modelID: "beta" }, effort: "high" }
    turn.prompt = { ...turn.prompt, permissionMode: "review" }
    const events = []
    for await (const event of context.transport.send(context.session, turn, context.turnBroker())) events.push(event)
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    const requests = (await (context.backend as ParityBackend).requests()).filter((row) => row.method !== "session/new")
    expect(requests.map((row) => [row.method, row.params.configId, row.params.value])).toEqual([
      ["session/set_config_option", "mode", "review"],
      ["session/set_config_option", "model", "scripted/beta"],
      ["session/set_config_option", "thought_level", "high"],
      ["session/prompt", undefined, undefined],
    ])
    expect((await context.transport.config!.permissionModes({ session: context.session })).currentModeId).toBe("review")
    const preview = await context.transport.config!.options({ session: context.session }, "probe")
    expect(preview.resolvedModel).toEqual({ id: "scripted/beta", name: "Beta" })
    const capabilities = await context.transport.capabilities({ directory: context.backend.directory, sessionId: "s1" })
    expect(capabilities.effortLevels).toEqual({ status: "unresolved", models: [{ modelID: "scripted/beta", levels: ["low", "high"] }] })
    expect(capabilities.modelSelection).toEqual({ status: "optional" })
    const again = []
    for await (const event of context.transport.send(context.session, turn, context.turnBroker())) again.push(event)
    expect((await (context.backend as ParityBackend).requests()).filter((row) => row.method === "session/set_config_option")).toHaveLength(3)
  } finally { await context.close() }
}, 30_000)

test("ACP refuses an effort or model the agent does not offer or keep, without prompting", async () => {
  const refusal = async (env: Record<string, string>, turn: (base: TurnInputLike) => TurnInputLike, message: string) => {
    const context = await setupConformance({ name: "acp refused option", backend: () => parityBackend(env), makeTransport: parityTransport })
    try {
      const run = async () => { for await (const _event of context.transport.send(context.session, turn(context.turn("never sent")), context.turnBroker())) {} }
      expect(await rejectionMessage(run)).toContain(message)
      expect((await (context.backend as ParityBackend).requests()).some((row) => row.method === "session/prompt")).toBe(false)
    } finally { await context.close() }
  }
  await refusal({}, (base) => ({ ...base, effort: "max" }), "ACP agent does not offer effort max; it offers low, high")
  await refusal({}, (base) => ({ ...base, model: { providerID: "scripted", modelID: "gamma" } }), "ACP agent does not offer model gamma")
  await refusal({ PARITY_ACP_CLAMP_MODEL: "1" }, (base) => ({ ...base, model: { providerID: "scripted", modelID: "beta" } }),
    "ACP agent kept model scripted/alpha instead of scripted/beta")
}, 60_000)

test("the ACP agent picker reaches the agent through harnessConfig.update, and the agent list comes from the mode option", async () => {
  const context = await setupConformance({ name: "acp agent picker", backend: () => parityBackend(), makeTransport: parityTransport })
  try {
    expect(await context.transport.agents!.list({ session: context.session })).toEqual([
      { name: "default", description: "Default", mode: "primary" }, { name: "review", description: "Review", mode: "primary" }])
    const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
    expect(await context.transport.agents!.list({ draft })).toEqual(await context.transport.agents!.list({ session: context.session }))
    await context.transport.harnessConfig!.update(context.session, { agent: "review" })
    expect((await (context.backend as ParityBackend).requests()).some((row) => row.method === "session/set_config_option" && row.params.configId === "mode" && row.params.value === "review")).toBe(true)
    expect((await context.transport.config!.permissionModes({ session: context.session })).currentModeId).toBe("review")
  } finally { await context.close() }
}, 30_000)

test("ACP permission modes come from the modes channel with the agent's current mode", async () => {
  const context = await setupConformance({ name: "acp modes channel", backend: () => parityBackend({ PARITY_ACP_MODES_ONLY: "1" }), makeTransport: parityTransport })
  try {
    expect(await context.transport.config!.permissionModes({ session: context.session })).toEqual({
      modes: [{ id: "default", name: "Default" }, { id: "review", name: "Review" }], currentModeId: "default", appliesFrom: "immediate" })
    const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
    expect((await context.transport.config!.permissionModes({ draft })).modes.map((mode) => mode.id)).toEqual(["default", "review"])
    expect(await context.transport.agents!.list({ session: context.session })).toEqual([
      { name: "default", description: "Default", mode: "primary" }, { name: "review", description: "Review", mode: "primary" }])
    expect((await context.transport.config!.setPermissionMode(context.session, "review")).currentModeId).toBe("review")
    expect((await (context.backend as ParityBackend).requests()).some((row) => row.method === "session/set_mode" && row.params.modeId === "review")).toBe(true)
    await expect(context.transport.config!.setPermissionMode(context.session, "bogus")).rejects.toThrow("does not offer permission mode bogus")
  } finally { await context.close() }
}, 30_000)

test.each(["0", "1"])("ACP changes permission modes during an active prompt with modes-only=%s", async (modesOnly) => {
  const context = await setupConformance({ name: "acp live permissions",
    backend: () => parityBackend({ PARITY_ACP_MODES_ONLY: modesOnly, PARITY_ACP_HOLD_FOR_MODE: "1" }), makeTransport: parityTransport })
  const state = context.backend as ParityBackend
  const running = (async () => {
    const events = []
    for await (const event of context.transport.send(context.session, context.turn("hold for the mode change"), context.turnBroker())) events.push(event)
    return events
  })()
  try {
    await waitFor(async () => (await state.requests()).some((row) => row.method === "session/prompt") || undefined, "held ACP prompt")
    const applied = await context.transport.config!.setPermissionMode(context.session, "review")
    expect(applied).toMatchObject({ currentModeId: "review", appliesFrom: "immediate" })
    expect(JSON.stringify(await running)).toContain("review")
    const requests = await state.requests()
    expect(requests.filter((row) => row.method === "session/new")).toHaveLength(1)
    expect(requests.filter((row) => row.method === "session/prompt")).toHaveLength(1)
    expect(requests.at(-1)?.method).toBe(modesOnly === "1" ? "session/set_mode" : "session/set_config_option")
  } finally { await context.close() }
}, 30_000)

test("ACP changes model and effort while the original prompt remains active", async () => {
  const context = await setupConformance({ name: "acp live model", backend: () => parityBackend({ PARITY_ACP_HOLD_FOR_SETTINGS: "1" }), makeTransport: parityTransport })
  const state = context.backend as ParityBackend
  const running = (async () => {
    const events = []
    for await (const event of context.transport.send(context.session, context.turn("hold for model settings"), context.turnBroker())) events.push(event)
    return events
  })()
  try {
    await waitFor(async () => (await state.requests()).some((row) => row.method === "session/prompt") || undefined, "held ACP prompt")
    await expect(context.transport.harnessConfig!.update(context.session, { model: { providerID: "scripted", modelID: "bogus" } })).rejects.toThrow("does not offer model")
    const applied = await context.transport.harnessConfig!.update(context.session, { model: { providerID: "scripted", modelID: "beta" }, variant: "high" })
    expect(applied).toMatchObject({ model: { providerID: "scripted", modelID: "beta" }, variant: "high" })
    expect(JSON.stringify(await running)).toContain("scripted/beta:high")
    const requests = await state.requests()
    expect(requests.filter((row) => row.method === "session/new")).toHaveLength(1)
    expect(requests.filter((row) => row.method === "session/prompt")).toHaveLength(1)
    expect(requests.some((row) => row.method === "session/cancel")).toBe(false)
  } finally { await context.close() }
}, 30_000)

test("a turn whose permission mode the agent clamps through the modes channel is refused", async () => {
  const context = await setupConformance({ name: "acp clamped mode", backend: () => parityBackend({ PARITY_ACP_MODES_ONLY: "1", PARITY_ACP_CLAMP_MODE: "1" }), makeTransport: parityTransport })
  try {
    const turn = context.turn("never sent")
    turn.prompt = { ...turn.prompt, permissionMode: "review" }
    const run = async () => { for await (const _event of context.transport.send(context.session, turn, context.turnBroker())) {} }
    expect(await rejectionMessage(run)).toContain("ACP kept permission mode default instead of review")
    expect((await (context.backend as ParityBackend).requests()).some((row) => row.method === "session/prompt")).toBe(false)
  } finally { await context.close() }
}, 30_000)

test("ACP delivers attachments by the agent's prompt capabilities", async () => {
  const context = await setupConformance({ name: "acp inline attachments",
    backend: () => parityBackend({ PARITY_ACP_PROMPT_CAPS: JSON.stringify({ image: true, audio: true, embeddedContext: true }) }), makeTransport: parityTransport })
  try {
    const turn = attachedTurn(context.turn("Review the attachments. Reply with exactly this one token: PARITY_OK"), [
      { type: "file", mime: "image/png", filename: "parity.png", url: `data:image/png;base64,${PNG}` },
      { type: "file", mime: "text/plain", filename: "parity.txt", url: `data:text/plain;base64,${TEXT_BASE64}` },
      { type: "file", mime: "audio/wav", filename: "parity.wav", url: `data:audio/wav;base64,${WAV_BASE64}` },
      { type: "file", mime: "image/png", filename: "remote.png", url: "https://attachments.invalid/remote.png" },
    ])
    for await (const _event of context.transport.send(context.session, turn, context.turnBroker())) {}
    const prompt = (await (context.backend as ParityBackend).requests()).find((row) => row.method === "session/prompt")?.params.prompt as Record<string, unknown>[]
    expect(prompt).toEqual([
      { type: "text", text: "Review the attachments. Reply with exactly this one token: PARITY_OK" },
      { type: "image", mimeType: "image/png", data: PNG },
      { type: "resource", resource: { uri: "wr://attachment/1", blob: TEXT_BASE64, mimeType: "text/plain" } },
      { type: "audio", mimeType: "audio/wav", data: WAV_BASE64 },
      { type: "resource_link", uri: "https://attachments.invalid/remote.png", name: "https://attachments.invalid/remote.png" },
    ])
  } finally { await context.close() }
}, 30_000)

test("an ACP attachment the agent cannot receive fails the turn before the prompt", async () => {
  const context = await setupConformance({ name: "acp undeliverable attachment",
    backend: () => parityBackend({ PARITY_ACP_PROMPT_CAPS: JSON.stringify({ image: true }) }), makeTransport: parityTransport })
  try {
    const turn = attachedTurn(context.turn("never sent"), [{ type: "file", mime: "text/plain", filename: "parity.txt", url: `data:text/plain;base64,${TEXT_BASE64}` }])
    const run = async () => { for await (const _event of context.transport.send(context.session, turn, context.turnBroker())) {} }
    await expect(run()).rejects.toThrow("ACP agent cannot receive a text/plain attachment: it negotiated no inline content and does not share the workspace")
    expect((await (context.backend as ParityBackend).requests()).some((row) => row.method === "session/prompt")).toBe(false)
    const events = []
    for await (const event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PARITY_OK"), context.turnBroker())) events.push(event)
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 30_000)

test("an ACP agent sharing the workspace receives attachments as files and links", async () => {
  const context = await setupConformance({ name: "acp shared filesystem attachments",
    backend: () => parityBackend({ PARITY_ACP_PROMPT_CAPS: JSON.stringify({}) }, { sharedFilesystem: true }), makeTransport: parityTransport })
  try {
    const turn = attachedTurn(context.turn("Read the file. Reply with exactly this one token: PARITY_OK"), [
      { type: "file", mime: "text/plain", filename: "parity.txt", url: `data:text/plain;base64,${TEXT_BASE64}` }])
    for await (const _event of context.transport.send(context.session, turn, context.turnBroker())) {}
    const prompt = (await (context.backend as ParityBackend).requests()).find((row) => row.method === "session/prompt")?.params.prompt as Record<string, unknown>[]
    const link = prompt.find((block) => block.type === "resource_link") as { uri: string; name: string; mimeType: string } | undefined
    expect(link).toMatchObject({ name: "parity.txt", mimeType: "text/plain" })
    const written = fileURLToPath(link!.uri)
    expect(written.startsWith(path.join(context.backend.directory, ".claxedo", "attachments"))).toBe(true)
    expect(await fs.readFile(written, "utf8")).toBe("ACP parity text attachment\n")
    expect((prompt[0] as { text: string }).text).toBe(`Read the file. Reply with exactly this one token: PARITY_OK\nAttached file (text/plain): ${written}`)
  } finally { await context.close() }
}, 30_000)

test("ACP names a session through a throwaway session on the same agent", async () => {
  const context = await setupConformance({ name: "acp title",
    backend: () => parityBackend({ PARITY_ACP_TITLE_MARK: "Generate a concise, single-line title" }), makeTransport: parityTransport })
  try {
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PARITY_OK"), context.turnBroker())) {}
    const title = await context.transport.naming!.generateTitle!(context.session, { directory: context.backend.directory, system: SESSION_TITLE_SYSTEM_PROMPT,
      user: "<conversation>\nUser: Reply with exactly this one token: PARITY_OK\n</conversation>", signal: AbortSignal.timeout(20_000) })
    expect(title).toBe("Scripted parity title")
    const requests = await (context.backend as ParityBackend).requests()
    expect(requests.filter((row) => row.method === "session/new")).toHaveLength(2)
    const prompts = requests.filter((row) => row.method === "session/prompt")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.params.sessionId).not.toBe(context.session.binding.upstreamSessionId)
    expect(JSON.stringify(prompts[0]?.params)).not.toContain("Generate a concise")
    const events = []
    for await (const event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PARITY_OK"), context.turnBroker())) events.push(event)
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
}, 30_000)
