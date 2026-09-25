import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runConformance, setupConformance, type ConformanceBackend } from "./test-support/run"
import { filterMcpServers } from "../capabilities/mcp-filter"
import { AcpTransport } from "../transports/acp"
import { startScriptedAcpWebSocket } from "../../e2e/harness/acp/websocket"
import { acpScriptToken, writeAcpScript } from "../../e2e/harness/acp/script"
import { readAcpRequests } from "../../e2e/harness/acp/requests"
import { expect, test } from "bun:test"
import { createSessionBroker } from "../broker"
import { authority } from "./test-support/memory-ports"

type AcpBackend = ConformanceBackend & {
  root: string
  connection: ConstructorParameters<typeof AcpTransport>[1]
}

async function backend(kind: "process" | "websocket", restoreMode: "resume" | "load" = "resume", supportsMcpServers = true,
  holdMethod?: string, red = false, startupQuestion = false): Promise<AcpBackend> {
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
  await writeAcpScript(directory, "subagent", { steps: [{ kind: "subagent", name: "Researcher", task: "Inspect the file",
    steps: [{ kind: "text", text: "Child result" }] }] })
  const server = kind === "websocket" ? await startScriptedAcpWebSocket(directory, { restoreMode, holdMethod, startupQuestion }) : undefined
  const connection = server
    ? { kind: "websocket" as const, url: server.url, supportsMcpServers }
    : { kind: "process" as const, command: process.execPath,
      args: [path.join(import.meta.dirname, "../../e2e/harness/acp/agent.ts")],
      env: { SCRIPTED_ACP_DIR: directory, ...(holdMethod === "session/new" ? { SCRIPTED_ACP_HANG_NEW: "1" } : {}),
        ...(red ? { SCRIPTED_ACP_RED: "1" } : {}), ...(startupQuestion ? { SCRIPTED_ACP_START_QUESTION: "1" } : {}) } }
  return {
    root, directory, connection, locality: server ? "remote" : "local",
    harness: { id: "scripted-acp", access: "connection" },
    model: { providerID: "scripted-acp", modelID: "scripted" },
    credentials: { providers: {}, secrets: {}, leaseGeneration: "conformance" },
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
    mismatchOrigin: { actor: { kind: "person", userId: "other" }, via: "relay", reissued: false },
    close: async () => { await server?.close(); await fs.rm(root, { recursive: true, force: true }) },
  }
}

for (const kind of ["process", "websocket"] as const) {
  runConformance({
    name: `acp ${kind}`,
    backend: () => backend(kind),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
    },
  })
}

runConformance({
  name: "acp websocket load",
  backend: () => backend("websocket", "load"),
  makeTransport(services, state) {
    const peer = state as AcpBackend
    return new AcpTransport(services, peer.connection, filterMcpServers,
      async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
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
      }, () => "w1")
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

test("a busy workspace does not hold another workspace's ACP config restart", async () => {
  const context = await setupConformance({
    name: "acp workspace restart",
    backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") },
        (directory) => directory === peer.directory ? "w1" : "w2")
    },
  })
  try {
    const secondDirectory = path.join((context.backend as AcpBackend).root, "other")
    await fs.mkdir(secondDirectory)
    const secondStart = { ...context.start, sessionId: "s2", directory: secondDirectory }
    context.ports.current.set("s2", { ...authority, sessionId: "s2", directory: secondDirectory, workspaceId: "w2" })
    const secondBroker = createSessionBroker(context.owner, { sessionId: "s2", directory: secondDirectory,
      workspaceId: "w2", origin: context.start.origin })
    await context.transport.start(secondStart, secondBroker)
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
    expect(await context.transport.configure({ credentials: changed })).toEqual({ state: "deferred", until: "after-active-turns" })
    const beforeReply = await readAcpRequests(context.backend.directory)
    expect(beforeReply.some((row) => row.method === "session/resume" && row.params.cwd === secondDirectory)).toBe(true)
    expect(beforeReply.some((row) => row.method === "session/resume" && row.params.cwd === context.backend.directory)).toBe(false)
    const answer = await context.owner.broker.answer(pending!.request.requestId,
      { kind: "permission", decision: "deny" }, { sessionId: "s1" })
    expect(answer.ok).toBe(true)
    await running
    expect((await readAcpRequests(context.backend.directory)).some((row) => row.method === "session/resume" && row.params.cwd === context.backend.directory)).toBe(true)
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
        async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
    },
  })).rejects.toThrow("session/new timed out")
  expect(processes).toHaveLength(1)
  expect((await processes[0]!.exited).signal).not.toBeNull()
})

test("the targeted red ACP agent fails at session/prompt", async () => {
  const context = await setupConformance({
    name: "acp red",
    backend: () => backend("process", "resume", true, undefined, true),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
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
        async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
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
        async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
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
        async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
    },
  })
  try {
    const run = async (message: string) => {
      for await (const _event of context.transport.send(context.session, context.turn(message), context.turnBroker())) {}
    }
    await expect(run(acpScriptToken("silence"))).rejects.toThrow("outcome is uncertain")
    await expect(run("next prompt")).rejects.toThrow("outcome is uncertain")
    let requests = await readAcpRequests(context.backend.directory)
    for (let attempt = 0; !requests.some((row) => row.method === "session/cancel") && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      requests = await readAcpRequests(context.backend.directory)
    }
    expect(requests.some((row) => row.method === "session/prompt")).toBe(true)
    expect(requests.some((row) => row.method === "session/cancel")).toBe(true)
  } finally { await context.close() }
})

test("ACP child updates use a child route and brokered lineage", async () => {
  const context = await setupConformance({
    name: "acp child",
    backend: () => backend("websocket"),
    makeTransport(services, state) {
      const peer = state as AcpBackend
      return new AcpTransport(services, peer.connection, filterMcpServers,
        async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
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
      async () => { throw new Error("No saved transcript in this conformance scenario") }, () => "w1")
  },
})
