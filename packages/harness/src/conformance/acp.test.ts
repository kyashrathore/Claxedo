import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runConformance, setupConformance, type ConformanceBackend } from "./test-support/run"
import { filterMcpServers } from "../capabilities/mcp-filter"
import { AcpTransport } from "../transports/acp"
import { startScriptedAcpWebSocket } from "../../e2e/harness/acp/websocket"
import { startScriptedAcpHttp } from "../../e2e/harness/acp/http"
import { acpScriptToken, writeAcpScript } from "../../e2e/harness/acp/script"
import { readAcpRequests } from "../../e2e/harness/acp/requests"
import { expect, test } from "bun:test"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority, origin } from "./test-support/memory-ports"
import { createTestServices } from "./test-support/services"
import { assertListedCommandsRun } from "./test-support/commands"

type AcpBackend = ConformanceBackend & {
  root: string
  connection: ConstructorParameters<typeof AcpTransport>[1]
}

async function backend(kind: "process" | "websocket" | "streamable-http", restoreMode: "resume" | "load" = "resume", supportsMcpServers = true,
  holdMethod?: string, red = false, startupQuestion = false, groups?: readonly string[]): Promise<AcpBackend> {
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
  await writeAcpScript(directory, "silence", { steps: [{ kind: "hold", name: "never-released" }] })
  await writeAcpScript(directory, "permission-silence", { steps: [
    { kind: "permission", tool: "execute", title: "Run scripted command", text: "permission result" },
    { kind: "hold", name: "never-released" },
  ] })
  await writeAcpScript(directory, "subagent", { steps: [{ kind: "subagent", name: "Researcher", task: "Inspect the file",
    steps: [{ kind: "text", text: "Child result" }] }] })
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
    model: { providerID: "scripted-acp", modelID: "scripted" },
    credentials: { providers: {}, secrets: {}, leaseGeneration: "conformance" },
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
    expectedMcp: supportsMcpServers ? "session" : "none", textCommand: acpScriptToken("text"), permissionCommand: acpScriptToken("permission"),
    close: async () => { await server?.close(); await fs.rm(root, { recursive: true, force: true }) },
  }
}

for (const kind of ["process", "websocket", "streamable-http"] as const) {
  runConformance({
    name: `acp ${kind}`,
    backend: () => backend(kind),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
    },
  })
}

test("every listed ACP command runs as a slash prompt", async () => {
  const context = await setupConformance({ name: "acp command proof", backend: () => backend("process"),
    makeTransport(services, state) {
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript") })
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
    return new AcpTransport(services, peer.connection, filterMcpServers,
      async () => { throw new Error("No saved transcript in this conformance scenario") })
  },
})

test("a missing native ACP session persists saved context before rebinding", async () => {
  const order: string[] = []
  const context = await setupConformance({
    name: "acp missing session",
    backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers, async () => {
        order.push("context")
        return { from: peer.harness, pending: true, transcript: "Saved conversation", reason: "missing-session" }
      })
    },
  })
  try {
    await context.transport.close(context.session)
    context.ports.persistHandoff = async (_sessionId, handoff) => {
      expect(handoff).toMatchObject({ transcript: "Saved conversation" })
      order.push("persist")
    }
    context.ports.rebind = async () => { order.push("rebind") }
    const attached = await context.transport.attach({ ...context.start,
      binding: { ...context.session.binding, upstreamSessionId: "missing-session" } }, context.sessionBroker)
    expect(attached.binding.upstreamSessionId).not.toBe("missing-session")
    expect(order).toEqual(["context", "persist", "rebind"])
    const requests = await readAcpRequests(context.backend.directory)
    expect(requests.map((item) => item.method)).toContain("session/resume")
    expect(requests.filter((item) => item.method === "session/new")).toHaveLength(2)
  } finally { await context.close() }
})

test("ACP publishes a command update received outside a turn", async () => {
  const context = await setupConformance({
    name: "acp outside commands", backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
    const changed = { ...context.start.credentials, leaseGeneration: "rotated" }
    expect(await context.transport.configure(context.session, { credentials: changed })).toEqual({ state: "deferred", until: "after-active-turns" })
    const beforeReply = await readAcpRequests(context.backend.directory)
    expect(beforeReply.some((row) => row.method === "session/resume" && row.params.cwd === secondDirectory)).toBe(false)
    expect(beforeReply.some((row) => row.method === "session/resume" && row.params.cwd === context.backend.directory)).toBe(false)
    const answer = await context.owner.broker.answer(pending!.request.requestId,
      { kind: "permission", decision: "deny" }, { sessionId: "s1" })
    expect(answer.ok).toBe(true)
    await running
    expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume" && row.params.cwd === context.backend.directory)).toBe(true)
    expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume" && row.params.cwd === secondSession.directory)).toBe(false)
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
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
    },
  })
  try {
    const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
    await context.transport.config?.options({ draft }, "probe")
    expect(descriptors).toEqual([
      { role: "harness", label: "ACP", sessionId: "s1" },
      { role: "probe", label: "ACP", sessionId: expect.stringMatching(/^probe-/) },
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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

test("the targeted red ACP agent fails at session/prompt", async () => {
  const context = await setupConformance({
    name: "acp red",
    backend: () => backend("process", "resume", true, undefined, true),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
    },
  })
  try {
    const running = async () => {
      for await (const _event of context.transport.send(context.session,
        context.turn("This must fail in the scripted ACP agent"), context.turnBroker())) {}
    }
    await expect(running()).rejects.toThrow("Scripted ACP red run")
    expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/prompt")).toBe(true)
  } finally { await context.close() }
})

test("a human permission wait suspends ACP's quiet deadline", async () => {
  const context = await setupConformance({
    name: "acp held permission",
    async backend() {
      const peer = await backend("websocket")
      return { ...peer, connection: { ...peer.connection, promptTimeoutMs: 100 } }
    },
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await context.owner.broker.answer(pending!.request.requestId,
      { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
    expect((await running).some((item) => item.event.type === "finish")).toBe(true)
  } finally { await context.close() }
})

test("a startup elicitation suspends session/new and binds to its reservation", async () => {
  let owner: ReturnType<typeof import("../broker").createRequestBroker> | undefined
  let ports: import("./test-support/memory-ports").MemoryPorts | undefined
  const started = setupConformance({
    name: "acp startup question",
    async backend() {
      const peer = await backend("websocket", "resume", true, undefined, false, true)
      return { ...peer, connection: { ...peer.connection, startupTimeoutMs: 100 },
        onSetup(context) { owner = context.owner; ports = context.ports } }
    },
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
    },
  })
  let pending = owner?.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "elicitation")
  for (let attempt = 0; !pending && attempt < 500; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    pending = owner?.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "elicitation")
  }
  expect(pending?.start).toEqual(ports?.startBinding)
  await new Promise((resolve) => setTimeout(resolve, 200))
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
  const transport = new AcpTransport(services, state.connection, filterMcpServers,
    async () => { throw new Error("No saved transcript in this conformance scenario") })
  const draft = { workspaceId: "w1", directory: state.directory, locality: "local" as const, owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }
  try {
    expect(await transport.config.options({ draft }, "peek")).toEqual([])
    const [first, second] = await Promise.all([
      transport.config.options({ draft }, "probe"), transport.config.options({ draft }, "probe"),
    ])
    expect(first).toEqual(second)
    expect(first.some((item) => item.id === "mode")).toBe(true)
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
  const transport = new AcpTransport(services, { ...state.connection, startupTimeoutMs: 100 }, filterMcpServers,
    async () => { throw new Error("No saved transcript in this conformance scenario") })
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
  const transport = new AcpTransport(services, state.connection, filterMcpServers,
    async () => { throw new Error("No saved transcript in this conformance scenario") })
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
  const transport = new AcpTransport(services, state.connection, filterMcpServers,
    async () => { throw new Error("No saved transcript in this conformance scenario") })
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
  filterMcpServers, async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
    },
  })
  try {
    const run = async (message: string) => {
      for await (const _event of context.transport.send(context.session, context.turn(message), context.turnBroker())) {}
    }
    await expect(run(acpScriptToken("silence"))).rejects.toThrow("outcome is uncertain")
    await expect(run("next prompt")).rejects.toThrow("outcome is uncertain")
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
    const attaching = context.transport.attach({ ...context.start, binding: context.session.binding }, context.sessionBroker)
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume")).toBe(true)
    expect(timers.size).toBe(1)
    timers.values().next().value!()
    await expect(attaching).rejects.toThrow("session restore timed out")
    expect(context.transport.health?.connection(context.backend.directory, "s1").state).toBe("disconnected")
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
      return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
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
      { credentials: { ...context.backend.credentials, leaseGeneration: "changed" } })
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume")) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(timers.size).toBe(1)
    timers.values().next().value!()
    await expect(restarting).rejects.toThrow("session restore timed out")
    expect(context.transport.health?.connection(context.backend.directory, "s1").state).toBe("disconnected")
    expect(context.transport.health?.connection(context.backend.directory, "s2").state).toBe("ready")
    const refused = async () => {
      for await (const _event of context.transport.send(context.session, context.turn("refused"), context.turnBroker())) {}
    }
    await expect(refused()).rejects.toThrow("not attached")
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
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") })
    },
  })
  try {
    const events = []
    for await (const event of context.transport.send(context.session,
      context.turn(acpScriptToken("subagent")), context.turnBroker())) events.push(event)
    expect(events.some((item) => item.route?.kind === "child" && item.event.type === "text-delta" && item.event.delta.includes("Child result"))).toBe(true)
    expect(context.ports.subagents.some((item) => item.status === "running")).toBe(true)
    expect(context.ports.subagents.some((item) => item.status === "completed")).toBe(true)
  } finally { await context.close() }
})

runConformance({
  name: "acp websocket without MCP support",
  backend: () => backend("websocket", "resume", false),
  makeTransport(services, state) {
    const peer = state as AcpBackend
    return new AcpTransport(services, peer.connection, filterMcpServers,
      async () => { throw new Error("No saved transcript in this conformance scenario") })
  },
})

for (const group of ["steer", "agents", "goals", "health"] as const) {
  for (const present of [true, false]) {
    test(`ACP scripted handshake ${present ? "declares" : "omits"} ${group}`, async () => {
      const context = await setupConformance({
        name: `acp ${group} ${present}`,
        backend: () => backend("websocket", "resume", true, undefined, false, false, present ? [group] : []),
        makeTransport(services, state) {
          return new AcpTransport(services, (state as AcpBackend).connection, filterMcpServers,
            async () => { throw new Error("No saved transcript in this conformance scenario") })
        },
      })
      try {
        const caps = await context.transport.capabilities({ directory: context.backend.directory, sessionId: "s1" })
        if (group === "steer") {
          expect(caps.steer).toBe(present)
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
          expect(caps.agents).toBe(present)
          expect(context.transport.agents !== undefined).toBe(present)
          if (present) expect(await context.transport.agents?.list({ session: context.session })).toHaveLength(2)
        } else if (group === "goals") {
          expect(caps.goals.available).toBe(present)
          expect(context.transport.goals !== undefined).toBe(present)
          if (present) {
            expect(await context.transport.goals?.read(context.session)).toBeNull()
            expect(await context.transport.goals?.start(context.session, "Ship the change", context.sessionBroker))
              .toMatchObject({ ok: true, goal: { sessionId: "s1", status: "active" } })
          }
        } else {
          expect(context.transport.health !== undefined).toBe(present)
          if (present) expect(context.transport.health?.runtime(context.backend.directory).status).toBe("ok")
        }
      } finally { await context.close() }
    })
  }
}
