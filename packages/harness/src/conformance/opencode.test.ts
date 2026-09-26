import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { startScriptedMcpServer } from "../../e2e/harness/scripted-mcp-server"
import { egressProxyEnv, startEgressGuard, unexpectedEgress } from "../../e2e/harness/egress-guard"
import { OpenCodeSdkTransport } from "../transports/opencode-sdk"
import { OpenCodeOwnerMismatchError } from "../transports/opencode-sdk/errors"
import type { OpenCodeRuntime } from "../transports/opencode-sdk/runtime"
import { WorkspaceScope } from "../transports/opencode-sdk/scope"
import { terminal } from "../transports/opencode-sdk/translate/event"
import type { TurnInput } from "../contract"
import { runConformance, setupConformance, type ConformanceBackend } from "./test-support/run"

type OpenCodeBackend = ConformanceBackend & { root: string; server: Awaited<ReturnType<typeof startScriptedModelServer>> }

async function backend(): Promise<OpenCodeBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-conformance-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const modelPort = await reservePort()
  const guardPort = await reservePort()
  const server = await startScriptedModelServer({ port: modelPort, red: false })
  const guard = await startEgressGuard(guardPort)
  const proxy = egressProxyEnv(guard.url)
  const previous = Object.fromEntries(Object.keys(proxy).map((key) => [key, process.env[key]]))
  Object.assign(process.env, proxy)
  const rotated: Array<{ port: number; server: Awaited<ReturnType<typeof startScriptedModelServer>> }> = []
  let permissionPrimed = false
  return {
    execution: "in-process", root, directory, server, expectedMcp: "config",
    harness: { id: "opencode", access: "native" }, model: { providerID: "proof", modelID: "proof" },
    credentials: { providers: { proof: { baseUrl: server.v1Url, placeholder: "opencode-placeholder-one", authMode: "api-key" } },
      secrets: {}, leaseGeneration: "one" },
    owner: { kind: "person", userId: "owner" },
    origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
    sharedSender: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    textCommand: "Reply with exactly this one token: PICONFORM",
    get permissionCommand() {
      if (!permissionPrimed) {
        permissionPrimed = true
        server.scriptTool({ name: "shell", input: { command: "printf permission > conformance-permission.txt" },
          whenPromptIncludes: "OPENCODEPERMISSION" })
      }
      return "Use the shell tool to write OPENCODEPERMISSION to conformance-permission.txt"
    },
    hold: (marker) => server.holdTextReplies(marker),
    held: (marker) => server.textGateReached(marker),
    scriptTool: (name, input) => server.scriptTool({ name, input }),
    rotate: async () => {
      const port = await reservePort()
      const next = await startScriptedModelServer({ port, red: false })
      rotated.push({ port, server: next })
      return { credentials: { providers: { proof: { baseUrl: next.v1Url, placeholder: "opencode-placeholder-two",
        authMode: "api-key" as const } }, secrets: {}, leaseGeneration: "two" },
        observed: () => next.requests.some((request) => request.authorization === "Bearer opencode-placeholder-two") }
    },
    close: async () => {
      console.log(`OpenCode outbound attempts: ${JSON.stringify(guard.attempts)}`)
      const unexpected = unexpectedEgress(guard.attempts)
      await Promise.all(rotated.map(async (item) => { await item.server.close(); releasePort(item.port) }))
      await server.close()
      await guard.close()
      releasePort(modelPort)
      releasePort(guardPort)
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fs.rm(root, { recursive: true, force: true })
      expect(unexpected).toEqual([])
    },
  }
}

function transport(services: ConstructorParameters<typeof OpenCodeSdkTransport>[0], state: OpenCodeBackend) {
  return new OpenCodeSdkTransport(services, { databasePath: path.join(state.root, "opencode.db"),
    configContent: JSON.stringify({ model: "proof/proof", small_model: "proof/proof", enabled_providers: ["proof"],
      provider: { proof: { npm: "@ai-sdk/openai-compatible", name: "Proof",
        models: { proof: { name: "Proof", limit: { context: 32_000, output: 1_024 } } } } },
      agent: { pi: { description: "Conformance", prompt: "Follow the instruction exactly" } },
      permission: { shell: "ask", question: "allow" },
    }) })
}

runConformance({ name: "opencode-sdk", backend,
  makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })

test("OpenCode loads projected MCP and skills through engine hooks without writing project config", async () => {
  const mcp = await startScriptedMcpServer()
  const context = await setupConformance({ name: "opencode-mcp", backend: async () => {
    const state = await backend()
    const plugin = path.join(state.root, "plugin")
    const skill = path.join(plugin, "skills", "conform-skill")
    await fs.mkdir(skill, { recursive: true })
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: conform-skill\ndescription: Conformance plugin\n---\nSKILL_MARKER\n")
    return { ...state, projection: { generation: "mcp", pluginRoots: [
      { pluginInstanceId: "conform", root: plugin, dataRoot: plugin },
    ], notApplied: [], mcpServers: [
      { kind: "http" as const, name: "proof", url: mcp.url, origin: "configured" as const },
    ] } }
  }, makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    expect(mcp.methods).toContain("initialize")
    expect(mcp.methods).toContain("tools/list")
    expect(await fs.readdir(context.backend.directory)).not.toContain("opencode.json")
    const state = context.backend as OpenCodeBackend
    state.server.scriptToolSequence("OPENCODESKILL", [{ name: "skill", input: { id: "conform-skill" } }])
    const events = await collect(context, context.turn("Use conform-skill for OPENCODESKILL"))
    expect(JSON.stringify(events)).toContain("SKILL_MARKER")
  } finally { await context.close(); await mcp.close() }
}, 60_000)

test("two sessions in one directory call first-party tools with their own identity", async () => {
  const port = await reservePort()
  const calls: Array<{ session: string; authorization: string; name: string }> = []
  const mcp = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const session = new URL(request.url).searchParams.get("session") ?? ""
    const authorization = request.headers.get("authorization") ?? ""
    if (authorization !== `Bearer first-party-${session}` || !["s1", "s2"].includes(session)) return new Response("Unauthorized", { status: 401 })
    const message = await request.json() as { id: number; method: string; params?: { name?: string } }
    if (message.method !== "initialize" && request.headers.get("mcp-session-id") !== `mcp-${session}`) {
      return new Response("MCP session mismatch", { status: 400 })
    }
    if (message.method === "tools/call") calls.push({ session, authorization, name: message.params?.name ?? "" })
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "first-party", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "claxedo_proof", description: "Return the calling identity", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: `FIRST_PARTY:${session}` }] }
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
      { headers: { "content-type": "text/event-stream", "mcp-session-id": `mcp-${session}` } })
  } })
  let context: Awaited<ReturnType<typeof setupConformance>> | undefined
  try {
    context = await setupConformance({ name: "opencode-session-tools", backend: async () => {
      const state = await backend()
      state.configureServices = (services) => { services.firstPartyMcp = (sessionId) => ({ kind: "http", name: "claxedo",
        url: `http://127.0.0.1:${port}/mcp?session=${sessionId}`, headers: { Authorization: `Bearer first-party-${sessionId}` } }) }
      return state
    }, makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
    const second = await context.transport.start({ ...context.start, sessionId: "s2" }, { ...context.sessionBroker,
      rebind: async () => undefined })
    const state = context.backend as OpenCodeBackend
    state.server.scriptTool({ name: "claxedo_proof", input: {}, whenPromptIncludes: "FIRSTONE" })
    expect(JSON.stringify(await collect(context, context.turn("Call claxedo_proof for FIRSTONE")))).toContain("FIRST_PARTY:s1")
    state.server.scriptTool({ name: "claxedo_proof", input: {}, whenPromptIncludes: "FIRSTTWO" })
    const secondEvents = []
    for await (const event of context.transport.send(second, context.turn("Call claxedo_proof for FIRSTTWO"), context.turnBroker())) secondEvents.push(event)
    expect(JSON.stringify(secondEvents)).toContain("FIRST_PARTY:s2")
    expect(calls).toEqual([
      { session: "s1", authorization: "Bearer first-party-s1", name: "claxedo_proof" },
      { session: "s2", authorization: "Bearer first-party-s2", name: "claxedo_proof" },
    ])
    const forged = await fetch(`http://127.0.0.1:${port}/mcp?session=s2`, { method: "POST",
      headers: { Authorization: "Bearer first-party-s1", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "claxedo_proof", arguments: {} } }) })
    expect(forged.status).toBe(401)
    expect(calls).toHaveLength(2)
    expect(await fs.readdir(context.backend.directory)).not.toContain("opencode.json")
  } finally {
    await context?.close()
    await mcp.stop(true)
    releasePort(port)
  }
}, 60_000)

test("one embedded engine refuses a different owner", async () => {
  const context = await setupConformance({ name: "opencode-owner", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    await expect(context.transport.start({ ...context.start, sessionId: "foreign", owner: { kind: "person", userId: "foreign" } },
      context.sessionBroker)).rejects.toBeInstanceOf(OpenCodeOwnerMismatchError)
  } finally { await context.close() }
}, 60_000)

test("one embedded engine refuses a second selected account before rebinding the first", async () => {
  const context = await setupConformance({ name: "opencode-account-isolation", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const rotation = await (context.backend as OpenCodeBackend).rotate!()
    await expect(context.transport.start({ ...context.start, sessionId: "s2", credentials: rotation.credentials },
      { ...context.sessionBroker, rebind: async () => undefined })).rejects.toThrow("different selected accounts")
    const events = await collect(context, context.turn("Reply with exactly FIRSTACCOUNT"))
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    expect((context.backend as OpenCodeBackend).server.requests.some((request) =>
      request.prompt.includes("FIRSTACCOUNT") && request.authorization === "Bearer opencode-placeholder-one")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("credential rotation waits until other OpenCode sessions using the old account close", async () => {
  const context = await setupConformance({ name: "opencode-account-rotation-isolation", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const second = await context.transport.start({ ...context.start, sessionId: "s2" },
      { ...context.sessionBroker, rebind: async () => undefined })
    const rotation = await (context.backend as OpenCodeBackend).rotate!()
    await expect(context.transport.configure(context.session, { credentials: rotation.credentials }))
      .rejects.toThrow("different selected accounts")
    await context.transport.close(second)
    expect((await context.transport.configure(context.session, { credentials: rotation.credentials })).state).toBe("applied")
    const events = await collect(context, context.turn("Reply with exactly ROTATIONAFTERCLOSE"))
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    expect(rotation.observed()).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("a failed OpenCode open releases its launch document ownership", async () => {
  const context = await setupConformance({ name: "opencode-failed-open", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const directory = path.join((context.backend as OpenCodeBackend).root, "second")
    await fs.mkdir(directory)
    const first = { ...context.start, sessionId: "failed", workspaceId: "second", directory }
    let failedID: string | undefined
    await expect(context.transport.start(first, { ...context.sessionBroker,
      rebind: async (upstream) => { failedID = upstream; throw new Error("rebind refused") } })).rejects.toThrow("rebind refused")
    const runtime = (context.transport as OpenCodeSdkTransport as unknown as { runtime: OpenCodeRuntime }).runtime
    const scope = WorkspaceScope.authorize({ workspaceID: "second", directory })
    expect((await runtime.sessions.list(scope)).sessions.map((session) => session.id)).not.toContain(failedID)
    const plugin = path.join((context.backend as OpenCodeBackend).root, "replacement-plugin")
    const skill = path.join(plugin, "skills", "replacement")
    await fs.mkdir(skill, { recursive: true })
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: replacement\ndescription: Replacement\n---\n")
    const second = { ...first, sessionId: "replacement", projection: { ...first.projection,
      pluginRoots: [{ pluginInstanceId: "replacement", root: plugin, dataRoot: plugin }] } }
    const opened = await context.transport.start(second, { ...context.sessionBroker, rebind: async () => undefined })
    expect(opened.binding.sessionId).toBe("replacement")
  } finally { await context.close() }
}, 60_000)

test("an aborted OpenCode turn settles while the model reply is held", async () => {
  const context = await setupConformance({ name: "opencode-abort", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const state = context.backend as OpenCodeBackend
  const release = state.server.holdTextReplies("ABORTHELD")
  let running: Promise<unknown> | undefined
  try {
    const controller = new AbortController()
    running = collectEvents(context.transport.send(context.session, context.turn("Reply with exactly ABORTHELD"),
      context.turnBroker(controller.signal)))
    await state.server.textGateReached("ABORTHELD")
    controller.abort()
    const settled = await Promise.race([running.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))])
    expect(settled).toBe(true)
  } finally { release(); await running; await context.close() }
}, 60_000)

test("a lost OpenCode terminal event settles from the SDK session snapshot", async () => {
  const context = await setupConformance({ name: "opencode-lost-terminal", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const target = context.transport as OpenCodeSdkTransport as unknown as { runtime: OpenCodeRuntime }
  const actual = target.runtime
  try {
    const lost = new Set<() => void>()
    target.runtime = { ...actual, events: { ...actual.events,
      subscribe(listener) {
        return actual.events.subscribe((event) => {
          if (terminal(event, context.session.binding.upstreamSessionId)) {
            for (const notify of lost) notify()
          } else listener(event)
        })
      },
      subscribeLoss(listener) { lost.add(listener); return () => lost.delete(listener) },
    } }
    const events = await collect(context, context.turn("Reply with exactly LOSTTERMINAL"))
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    target.runtime = actual
    const next = await collect(context, context.turn("Reply with exactly AFTERLOSS"))
    expect(next.some((item) => item.event.type === "finish")).toBe(true)
  } finally { target.runtime = actual; await context.close() }
}, 60_000)

async function collectEvents(events: AsyncIterable<unknown>) {
  const collected = []
  for await (const event of events) collected.push(event)
  return collected
}

async function waitForRequest(context: Awaited<ReturnType<typeof setupConformance>>, kind: "permission" | "question") {
  for (let attempt = 0; attempt < 500; attempt++) {
    const found = context.owner.broker.list({ sessionId: context.session.binding.sessionId }).find((row) => row.request.kind === kind)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`OpenCode ${kind} did not reach the broker`)
}

async function collect(context: Awaited<ReturnType<typeof setupConformance>>, input: TurnInput) {
  const events = []
  for await (const event of context.transport.send(context.session, input, context.turnBroker())) events.push(event)
  return events
}

test("OpenCode question reaches the broker and its saved answer releases the engine", async () => {
  const context = await setupConformance({ name: "opencode-question", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const state = context.backend as OpenCodeBackend
    state.server.scriptTool({ name: "question", input: { questions: [{ header: "Proceed", question: "Continue?",
      options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }] }] } })
    const running = collect(context, context.turn("Ask OPENCODEQUESTION then continue"))
    const question = await waitForRequest(context, "question")
    const answered = await context.owner.broker.answer(question.request.requestId, { kind: "answers", answers: [["Yes"]] },
      { sessionId: context.session.binding.sessionId })
    expect(answered.ok).toBe(true)
    expect((await running).some((item) => item.event.type === "finish")).toBe(true)
    expect(context.ports.saved.some((row) => row.answer.kind === "answers")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("OpenCode credential rotation leaves a running turn intact and changes the next request", async () => {
  const context = await setupConformance({ name: "opencode-rotation", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const state = context.backend as OpenCodeBackend
    const release = state.server.holdTextReplies("ROTATEINFLIGHT")
    const running = collect(context, context.turn("Reply with exactly ROTATEINFLIGHT"))
    for (let attempt = 0; attempt < 500 && state.server.requests.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(state.server.requests.some((request) => request.prompt.includes("ROTATEINFLIGHT") &&
      request.authorization === "Bearer opencode-placeholder-one")).toBe(true)
    const rotation = await state.rotate!()
    expect((await context.transport.configure(context.session, { credentials: rotation.credentials })).state).toBe("applied")
    release()
    expect((await running).some((item) => item.event.type === "finish")).toBe(true)
    const next = await collect(context, context.turn("Reply with exactly ROTATEDNEXT"))
    expect(next.some((item) => item.event.type === "finish")).toBe(true)
    expect(rotation.observed()).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("an unavailable selected OpenCode account cannot reach the model or a machine login", async () => {
  const context = await setupConformance({ name: "opencode-unavailable", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const state = context.backend as OpenCodeBackend
    const credentials = { ...state.credentials, providers: { proof: { unavailable: true as const, reason: "account_revoked" } },
      leaseGeneration: "revoked" }
    expect((await context.transport.configure(context.session, { credentials })).state).toBe("applied")
    const events = await collect(context, context.turn("Reply with exactly UNAVAILABLE"))
    expect(events.some((item) => item.event.type === "error" && item.event.error.includes("account_revoked"))).toBe(true)
    expect(state.server.requests).toHaveLength(0)
  } finally { await context.close() }
}, 60_000)
