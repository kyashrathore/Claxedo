import fs from "node:fs/promises"
import { harnessEffortVerdict } from "@claxedo/agent-runtime-contract"
import os from "node:os"
import path from "node:path"
import { afterAll, expect, test } from "bun:test"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { startScriptedMcpServer } from "../../e2e/harness/scripted-mcp-server"
import { egressProxyEnv, startEgressGuard, unexpectedEgress, type EgressGuard } from "../../e2e/harness/egress-guard"
import { OpenCodeSdkTransport } from "../transports/opencode-sdk"
import { OpenCodeOwnerMismatchError } from "../transports/opencode-sdk/errors"
import type { OpenCodeRuntime } from "../transports/opencode-sdk/runtime"
import { WorkspaceScope } from "../transports/opencode-sdk/scope"
import { terminal } from "../transports/opencode-sdk/translate/event"
import type { RoutedEvent, TurnInput } from "../contract"
import { runConformance, setupConformance, type SuiteBackend } from "./test-support/run"
import { createTestServices } from "./test-support/services"

type ScriptedServer = Awaited<ReturnType<typeof startScriptedModelServer>>
type OpenCodeBackend = SuiteBackend & { root: string; server: ScriptedServer; rotated: ScriptedServer[] }

let engineEgress: Promise<EgressGuard> | undefined

function engineEgressGuard(): Promise<EgressGuard> {
  engineEgress ??= reservePort().then(startEgressGuard).then((guard) => {
    Object.assign(process.env, egressProxyEnv(guard.url))
    return guard
  })
  return engineEgress
}

afterAll(async () => { await (await engineEgress)?.close() })

async function backend(): Promise<OpenCodeBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-conformance-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const modelPort = await reservePort()
  const server = await startScriptedModelServer({ port: modelPort, red: false })
  const guard = await engineEgressGuard()
  const attemptsBefore = guard.attempts.length
  const rotated: Array<{ port: number; server: ScriptedServer }> = []
  let permissionPrimed = false
  return {
    execution: "in-process", root, directory, server, get rotated() { return rotated.map((item) => item.server) },
    harness: { id: "opencode", access: "native" }, model: { providerID: "proof", modelID: "proof" },
    credentials: { machineLoginAllowed: false, accountOwner: "fixture-owner", providers: { proof: { baseUrl: server.v1Url, placeholder: "opencode-placeholder-one", authMode: "api-key" } },
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
    scriptThinking: (input) => server.scriptText(input),
    unrunnableTurn: (turn) => ({ ...turn, model: undefined }),
    rotate: async () => {
      const port = await reservePort()
      const next = await startScriptedModelServer({ port, red: false })
      rotated.push({ port, server: next })
      return { credentials: { machineLoginAllowed: false, accountOwner: "fixture-owner", providers: { proof: { baseUrl: next.v1Url, placeholder: "opencode-placeholder-two",
        authMode: "api-key" as const } }, secrets: {}, leaseGeneration: "two" },
        observed: () => next.requests.some((request) => request.authorization === "Bearer opencode-placeholder-two") }
    },
    close: async () => {
      const attempts = guard.attempts.slice(attemptsBefore)
      console.log(`OpenCode outbound attempts: ${JSON.stringify(attempts)}`)
      const unexpected = unexpectedEgress(attempts)
      await Promise.all(rotated.map(async (item) => { await item.server.close(); releasePort(item.port) }))
      await server.close()
      releasePort(modelPort)
      await fs.rm(root, { recursive: true, force: true })
      expect(unexpected).toEqual([])
    },
  }
}

const PROOF_MODEL = { name: "Proof", limit: { context: 32_000, output: 1_024 } }

function proofProvider(extra: Record<string, unknown> = {}, models: Record<string, unknown> = {}) {
  return { npm: "@ai-sdk/openai-compatible", name: "Proof", models: { proof: PROOF_MODEL, ...models }, ...extra }
}

function transport(services: ConstructorParameters<typeof OpenCodeSdkTransport>[0], state: OpenCodeBackend,
  config: Record<string, unknown> = {}) {
  return new OpenCodeSdkTransport(services, {
    databasePath: path.join(state.root, "opencode.db"),
    configContent: JSON.stringify({ model: "proof/proof", small_model: "proof/proof", enabled_providers: ["proof"],
      provider: { proof: proofProvider() },
      agent: { pi: { description: "Conformance", prompt: "Follow the instruction exactly" } },
      permission: { shell: "ask", question: "allow" },
      ...config,
    }) })
}

async function writeSkill(root: string, plugin: string, skill: string, marker: string): Promise<string> {
  const directory = path.join(root, plugin)
  await fs.mkdir(path.join(directory, "skills", skill), { recursive: true })
  await fs.writeFile(path.join(directory, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${marker}\n---\n${marker}\n`)
  return directory
}

function withEnv(name: string, value: string): () => void {
  const previous = process.env[name]
  process.env[name] = value
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

runConformance({ name: "opencode-sdk", backend,
  makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })

test("OpenCode loads projected MCP and skills through engine hooks without writing project config", async () => {
  const mcp = await startScriptedMcpServer()
  const context = await setupConformance({ name: "opencode-mcp", backend: async () => {
    const state = await backend()
    const plugin = await writeSkill(state.root, "plugin", "conform-skill", "SKILL_MARKER")
    return Object.assign(state, { projection: { generation: "mcp", pluginRoots: [
      { pluginInstanceId: "conform", root: plugin, skillNames: ["conform-skill"], dataRoot: plugin },
    ], notApplied: [], mcpServers: [
      { kind: "http" as const, name: "proof", url: mcp.url, origin: "configured" as const },
    ] } })
  }, makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const state = context.backend as OpenCodeBackend
    state.server.scriptTool({ name: "skill", input: { id: "conform-skill" }, whenPromptIncludes: "OPENCODESKILL" })
    const events = await collect(context, context.turn("Use conform-skill for OPENCODESKILL"))
    expect(JSON.stringify(events)).toContain("SKILL_MARKER")
    expect(mcp.methods).toContain("initialize")
    expect(mcp.methods).toContain("tools/list")
    expect(await fs.readdir(context.backend.directory)).not.toContain("opencode.json")
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
        ? { tools: [{ name: "claxedo_proof", description: "Return the calling identity", inputSchema: { type: "object" } },
          ...session === "s1" ? [{ name: "claxedo_owner_only", description: "Offered to s1 alone", inputSchema: { type: "object" } }] : []] }
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
    const first = context
    const second = await context.transport.start({ ...context.start, sessionId: "s2" }, { ...context.sessionBroker,
      rebind: async (upstreamSessionId) => ({ ...first.session.binding, sessionId: "s2", upstreamSessionId }) })
    const state = context.backend as OpenCodeBackend
    state.server.scriptTool({ name: "claxedo_proof", input: {}, whenPromptIncludes: "FIRSTONE" })
    expect(JSON.stringify(await collect(context, context.turn("Call claxedo_proof for FIRSTONE")))).toContain("FIRST_PARTY:s1")
    state.server.scriptTool({ name: "claxedo_proof", input: {}, whenPromptIncludes: "FIRSTTWO" })
    const secondEvents = []
    for await (const event of context.transport.send(second, context.turn("Call claxedo_proof for FIRSTTWO"), context.turnBroker())) secondEvents.push(event)
    expect(JSON.stringify(secondEvents)).toContain("FIRST_PARTY:s2")
    const offered = (marker: string) => state.server.requests.filter((request) => request.prompt.includes(marker) && request.tools.length)
      .map((request) => request.tools.map((tool) => tool.name))
    expect(offered("FIRSTONE")[0]).toEqual(expect.arrayContaining(["claxedo_proof", "claxedo_owner_only"]))
    expect(offered("FIRSTTWO").length).toBeGreaterThan(0)
    for (const names of offered("FIRSTTWO")) {
      expect(names).toContain("claxedo_proof")
      expect(names).not.toContain("claxedo_owner_only")
    }
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
    await expect(context.transport.start({ ...context.start, sessionId: "foreign", owner: { kind: "person", userId: "foreign" }, credentials: { ...context.start.credentials, accountOwner: "foreign" } },
      context.sessionBroker)).rejects.toBeInstanceOf(OpenCodeOwnerMismatchError)
  } finally { await context.close() }
}, 60_000)

test("one embedded engine refuses a second selected account before rebinding the first", async () => {
  const context = await setupConformance({ name: "opencode-account-isolation", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const rotation = await (context.backend as OpenCodeBackend).rotate!()
    await expect(context.transport.start({ ...context.start, sessionId: "s2", credentials: rotation.credentials },
      { ...context.sessionBroker, rebind: async (upstreamSessionId) => ({ ...context.session.binding, sessionId: "s2", upstreamSessionId }) }))
      .rejects.toThrow("different selected accounts")
    const events = await collect(context, context.turn("Reply with exactly FIRSTACCOUNT"))
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    expect((context.backend as OpenCodeBackend).server.requests.some((request) =>
      request.prompt.includes("FIRSTACCOUNT") && request.authorization === "Bearer opencode-placeholder-one")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("an account switch rebinds the engine once for every session of the owner", async () => {
  const context = await setupConformance({ name: "opencode-account-switch", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const target = context.transport as OpenCodeSdkTransport as unknown as { runtime: OpenCodeRuntime }
  const actual = target.runtime
  try {
    const second = await context.transport.start({ ...context.start, sessionId: "s2" },
      { ...context.sessionBroker, rebind: async (upstreamSessionId) => ({ ...context.session.binding, sessionId: "s2", upstreamSessionId }) })
    const state = context.backend as OpenCodeBackend
    const rotation = await state.rotate!()
    let rebinds = 0
    target.runtime = { ...actual, bindProviders: (...args) => { rebinds += 1; return actual.bindProviders(...args) } }
    expect((await context.transport.configure(context.session, { credentials: rotation.credentials })).state).toBe("applied")
    expect((await context.transport.configure(second, { credentials: rotation.credentials })).state).toBe("applied")
    expect(rebinds).toBe(1)
    const rotated = state.rotated.at(-1)!
    const secondEvents = []
    for await (const event of context.transport.send(second, context.turn("Reply with exactly SWITCHTWO"), context.turnBroker())) secondEvents.push(event)
    expect(secondEvents.some((item) => item.event.type === "finish")).toBe(true)
    expect(rotated.requests.some((request) => request.prompt.includes("SWITCHTWO") && request.authorization === "Bearer opencode-placeholder-two")).toBe(true)
    const firstEvents = await collect(context, context.turn("Reply with exactly SWITCHONE"))
    expect(firstEvents.some((item) => item.event.type === "finish")).toBe(true)
    expect(rotated.requests.some((request) => request.prompt.includes("SWITCHONE") && request.authorization === "Bearer opencode-placeholder-two")).toBe(true)
    expect(state.server.requests.some((request) => request.prompt.includes("SWITCH"))).toBe(false)
  } finally { target.runtime = actual; await context.close() }
}, 60_000)

test("a failed OpenCode open removes its session row and the folder opens another selection", async () => {
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
      pluginRoots: [{ pluginInstanceId: "replacement", root: plugin, skillNames: ["replacement"], dataRoot: plugin }] } }
    const opened = await context.transport.start(second, { ...context.sessionBroker,
      rebind: async (upstreamSessionId) => ({ ...context.session.binding, sessionId: second.sessionId, upstreamSessionId }) })
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

async function collectEvents(events: AsyncIterable<RoutedEvent>) {
  const collected: RoutedEvent[] = []
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
    await expect(collect(context, context.turn("Reply with exactly UNAVAILABLE")))
      .rejects.toMatchObject({ transport: "opencode", code: "configuration", message: expect.stringContaining("account_revoked") })
    expect(state.server.requests).toHaveLength(0)
  } finally { await context.close() }
}, 60_000)

test("a person's session neither lists nor runs an engine provider nobody bound", async () => {
  const strayPort = await reservePort()
  const stray = await startScriptedModelServer({ port: strayPort, red: false })
  const restore = withEnv("CLAXEDO_OPENCODE_STRAY_API_KEY", "stray-env-key")
  let context: Awaited<ReturnType<typeof setupConformance>> | undefined
  try {
    context = await setupConformance({ name: "opencode-unbound-provider", backend,
      makeTransport: (services, state) => transport(services, state as OpenCodeBackend, {
        enabled_providers: ["proof", "stray"],
        provider: { proof: proofProvider(), stray: { npm: "@ai-sdk/openai-compatible", name: "Stray",
          env: ["CLAXEDO_OPENCODE_STRAY_API_KEY"], options: { baseURL: stray.v1Url }, models: { stray: PROOF_MODEL } } },
      }) })
    const selection = (await context.transport.capabilities({ directory: context.backend.directory, sessionId: "s1" })).modelSelection
    if (selection.status !== "required") throw new Error(`OpenCode model selection is ${selection.status}`)
    expect(selection.models.map((model) => model.providerId)).not.toContain("stray")
    const events: unknown[] = []
    const opened = context
    const failure = await (async () => {
      const turn = { ...opened.turn("Reply with exactly STRAYRUN"), model: { providerID: "stray", modelID: "stray" } }
      for await (const event of opened.transport.send(opened.session, turn, opened.turnBroker())) events.push(event)
    })().then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ transport: "opencode", code: "configuration" })
    expect(events).toEqual([])
    expect(stray.requests).toHaveLength(0)
  } finally {
    restore()
    await context?.close()
    await stray.close()
    releasePort(strayPort)
  }
}, 60_000)

test("a bound provider runs on its placeholder while its own variable is set", async () => {
  const restore = withEnv("CLAXEDO_OPENCODE_PROOF_API_KEY", "proof-env-key")
  let context: Awaited<ReturnType<typeof setupConformance>> | undefined
  try {
    context = await setupConformance({ name: "opencode-bound-env", backend,
      makeTransport: (services, state) => transport(services, state as OpenCodeBackend, {
        provider: { proof: proofProvider({ env: ["CLAXEDO_OPENCODE_PROOF_API_KEY"] }) } }) })
    const events = await collect(context, context.turn("Reply with exactly BOUNDENV"))
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    const request = (context.backend as OpenCodeBackend).server.requests.find((row) => row.prompt.includes("BOUNDENV"))
    expect(request?.authorization).toBe("Bearer opencode-placeholder-one")
  } finally {
    restore()
    await context?.close()
  }
}, 60_000)

function joined(context: Awaited<ReturnType<typeof setupConformance>>, sessionId: string) {
  return { ...context.sessionBroker, rebind: async (upstreamSessionId: string) => ({ ...context.session.binding, sessionId, upstreamSessionId }) }
}

async function selection(root: string, name: string) {
  const mcp = await startScriptedMcpServer({ name: `${name}_probe`, description: `Probe for ${name}`,
    inputSchema: { type: "object", properties: {} }, result: () => ({ content: [{ type: "text", text: name }] }) })
  const plugin = await writeSkill(root, `${name}-plugin`, `${name}-skill`, `${name.toUpperCase()}_SKILL_MARKER`)
  return { mcp, projection: { generation: name, notApplied: [], mcpServers: [{ kind: "http" as const, name, url: mcp.url, origin: "configured" as const }],
    pluginRoots: [{ pluginInstanceId: name, root: plugin, skillNames: [`${name}-skill`], dataRoot: plugin }] } }
}

function offered(state: OpenCodeBackend, marker: string) {
  const request = state.server.requests.find((row) => row.prompt.includes(marker) && row.tools.length)
  const body = JSON.stringify(request?.body ?? null)
  return { mcp: ["alpha_probe", "beta_probe"].filter((name) => body.includes(name)),
    skills: ["alpha-skill", "beta-skill"].filter((name) => new RegExp(`id(?:>|&gt;)${name}(?:<|&lt;)/id`).test(body)) }
}

test("two sessions in one folder each see only their own MCP servers and skills from their first request", async () => {
  let alpha: Awaited<ReturnType<typeof selection>> | undefined
  const context = await setupConformance({ name: "opencode-instances", backend: async () => {
    const state = await backend()
    alpha = await selection(state.root, "alpha")
    return Object.assign(state, { projection: alpha.projection })
  }, makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const state = context.backend as OpenCodeBackend
  const beta = await selection(state.root, "beta")
  try {
    const second = await context.transport.start({ ...context.start, sessionId: "s2", projection: beta.projection }, joined(context, "s2"))
    expect((await collect(context, context.turn("Reply with exactly ALPHAFIRST"))).some((item) => item.event.type === "finish")).toBe(true)
    await collectEvents(context.transport.send(second, context.turn("Reply with exactly BETAFIRST"), context.turnBroker()))
    expect(offered(state, "ALPHAFIRST")).toEqual({ mcp: ["alpha_probe"], skills: ["alpha-skill"] })
    expect(offered(state, "BETAFIRST")).toEqual({ mcp: ["beta_probe"], skills: ["beta-skill"] })
    expect(await fs.readdir(context.backend.directory)).not.toContain("opencode.json")
  } finally { await context.close(); await alpha?.mcp.close(); await beta.mcp.close() }
}, 90_000)

test("a child session runs in its parent's instance and a session outside every instance is refused", async () => {
  let alpha: Awaited<ReturnType<typeof selection>> | undefined
  const context = await setupConformance({ name: "opencode-instance-child", backend: async () => {
    const state = await backend()
    alpha = await selection(state.root, "alpha")
    return Object.assign(state, { projection: alpha.projection })
  }, makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const state = context.backend as OpenCodeBackend
  try {
    state.server.scriptTool({ name: "subagent", input: { agent: "general", description: "child task", prompt: "Reply with exactly CHILDTURN" },
      whenPromptIncludes: "SPAWNCHILD" })
    expect((await collect(context, context.turn("Spawn a subagent for SPAWNCHILD"))).some((item) => item.event.type === "finish")).toBe(true)
    expect(offered(state, "CHILDTURN")).toEqual({ mcp: ["alpha_probe"], skills: ["alpha-skill"] })
    const runtime = (context.transport as unknown as { runtime: OpenCodeRuntime }).runtime
    const scope = WorkspaceScope.authorize({ workspaceID: context.start.workspaceId, directory: context.backend.directory })
    const children = (await runtime.sessions.list(scope)).sessions.filter((row) => row.id !== context.session.binding.upstreamSessionId)
    expect(children).toHaveLength(1)
    expect((await runtime.sessionCommands(scope, children[0]!.id)).length).toBeGreaterThan(0)
    const stranger = await runtime.sessions.create(scope, { title: "stranger" })
    await expect(runtime.sessionCommands(scope, stranger.id)).rejects.toThrow()
    await expect(runtime.sessions.prompt(scope, stranger.id, { text: "Reply with exactly STRANGER" })).rejects.toThrow()
    expect(state.server.requests.some((row) => row.prompt.includes("STRANGER"))).toBe(false)
  } finally { await context.close(); await alpha?.mcp.close() }
}, 90_000)

test("an MCP prompt is listed as the session's command and a turn naming it runs the prompt", async () => {
  const port = await reservePort()
  const fetched: unknown[] = []
  const mcp = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const message = await request.json() as { id?: number; method: string; params?: { name?: string; arguments?: unknown } }
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method === "prompts/get") fetched.push(message.params)
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "docs", version: "1" } }
      : message.method === "tools/list" ? { tools: [] }
      : message.method === "prompts/list" ? { prompts: [{ name: "review", description: "Review a focus", arguments: [{ name: "focus" }] }] }
      : message.method === "prompts/get"
        ? { messages: [{ role: "user", content: { type: "text", text: `PROMPTBODY focus=${String((message.params?.arguments as { focus?: string } | undefined)?.focus)}` } }] }
        : {}
    return Response.json({ jsonrpc: "2.0", id: message.id, result })
  } })
  const context = await setupConformance({ name: "opencode-mcp-prompt", backend: async () => Object.assign(await backend(), {
    projection: { generation: "prompt", pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "http" as const, name: "docs", url: `http://127.0.0.1:${port}/mcp`, origin: "configured" as const }] } }),
  makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const state = context.backend as OpenCodeBackend
  try {
    const listed = await (context.transport as OpenCodeSdkTransport).commands.list({ session: context.session })
    expect(listed.map((command) => command.name)).toContain("docs:review")
    expect((await collect(context, context.turn("/docs:review security"))).some((item) => item.event.type === "finish")).toBe(true)
    expect(fetched).toEqual([{ name: "review", arguments: { focus: "security" } }])
    expect(state.server.requests.some((row) => row.prompt.includes("PROMPTBODY focus=security"))).toBe(true)
    expect(state.server.requests.some((row) => row.prompt.includes("/docs:review"))).toBe(false)
  } finally { await context.close(); await mcp.stop(true); releasePort(port) }
}, 90_000)

test("a new instance whose MCP server never settles prompts at the bound, reports it once, and never waits again", async () => {
  const port = await reservePort()
  const stalled = Promise.withResolvers<Response>()
  const mcp = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => stalled.promise })
  const context = await setupConformance({ name: "opencode-mcp-unsettled", backend: async () => Object.assign(await backend(), {
    projection: { generation: "stalled", pluginRoots: [], notApplied: [],
      mcpServers: [{ kind: "http" as const, name: "stalled", url: `http://127.0.0.1:${port}/mcp`, origin: "configured" as const }] } }),
  makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    const diagnostics = (events: RoutedEvent[]) => events.flatMap((item) => item.event.type === "diagnostic" ? [item.event.diagnostic] : [])
    const first = await collect(context, context.turn("Reply with exactly STALLEDFIRST"))
    expect(first.some((item) => item.event.type === "finish")).toBe(true)
    expect(diagnostics(first)).toContainEqual(expect.objectContaining({ code: "opencode_mcp_unsettled", message: expect.stringContaining("stalled") }))
    const started = Date.now()
    const second = await collect(context, context.turn("Reply with exactly STALLEDSECOND"))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(diagnostics(second).map((diagnostic) => diagnostic.code)).not.toContain("opencode_mcp_unsettled")
  } finally { stalled.resolve(new Response(null, { status: 503 })); await context.close(); await mcp.stop(true); releasePort(port) }
}, 90_000)

test("a projection change reaches only that OpenCode session, at its next turn", async () => {
  const context = await setupConformance({ name: "opencode-session-projection", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const state = context.backend as OpenCodeBackend
  const alpha = await selection(state.root, "alpha")
  const release = state.server.holdTextReplies("HELDTURN")
  let running: Promise<unknown> | undefined
  try {
    const second = await context.transport.start({ ...context.start, sessionId: "s2" }, joined(context, "s2"))
    running = collect(context, context.turn("Reply with exactly HELDTURN"))
    await state.server.textGateReached("HELDTURN")
    expect(await context.transport.configure(context.session, { projection: alpha.projection })).toEqual({ state: "deferred", until: "after-active-turns" })
    release()
    await running
    expect(offered(state, "HELDTURN")).toEqual({ mcp: [], skills: [] })
    await collectEvents(context.transport.send(second, context.turn("Reply with exactly SIBLINGTURN"), context.turnBroker()))
    await collect(context, context.turn("Reply with exactly CHANGEDTURN"))
    expect(offered(state, "SIBLINGTURN")).toEqual({ mcp: [], skills: [] })
    expect(offered(state, "CHANGEDTURN")).toEqual({ mcp: ["alpha_probe"], skills: ["alpha-skill"] })
  } finally { release(); await running; await context.close(); await alpha.mcp.close() }
}, 90_000)

test("a broker abort interrupts the engine once and ends the turn as cancelled, never as finished", async () => {
  const context = await setupConformance({ name: "opencode-abort-interrupt", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const state = context.backend as OpenCodeBackend
  const target = context.transport as OpenCodeSdkTransport as unknown as { runtime: OpenCodeRuntime }
  const actual = target.runtime
  const release = state.server.holdTextReplies("ABORTINTERRUPT")
  let running: Promise<RoutedEvent[]> | undefined
  try {
    let interrupts = 0
    target.runtime = { ...actual, sessions: { ...actual.sessions,
      interrupt: (...args) => { interrupts += 1; return actual.sessions.interrupt(...args) } } }
    const controller = new AbortController()
    running = collectEvents(context.transport.send(context.session, context.turn("Reply with exactly ABORTINTERRUPT"),
      context.turnBroker(controller.signal)))
    await state.server.textGateReached("ABORTINTERRUPT")
    controller.abort()
    const events = await running
    expect(interrupts).toBe(1)
    expect(events.filter((item) => item.event.type === "error")).toEqual([])
    expect(events.some((item) => item.event.type === "cancelled")).toBe(true)
    expect(events.some((item) => item.event.type === "finish")).toBe(false)
    const scope = WorkspaceScope.authorize({ workspaceID: "w1", directory: context.backend.directory })
    expect((await actual.sessions.get(scope, context.session.binding.upstreamSessionId)).outcome).toBe("interrupted")
  } finally { target.runtime = actual; release(); await running; await context.close() }
}, 60_000)

test("a lost stream with no terminal outcome rejects the turn instead of yielding an error event", async () => {
  const context = await setupConformance({ name: "opencode-lost-without-outcome", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const target = context.transport as OpenCodeSdkTransport as unknown as { runtime: OpenCodeRuntime }
  const actual = target.runtime
  try {
    const lost = new Set<() => void>()
    target.runtime = { ...actual,
      events: { ...actual.events,
        subscribe(listener) {
          return actual.events.subscribe((event) => {
            if (terminal(event, context.session.binding.upstreamSessionId)) { for (const notify of lost) notify() }
            else listener(event)
          })
        },
        subscribeLoss(listener) { lost.add(listener); return () => lost.delete(listener) },
      },
      sessions: { ...actual.sessions, get: async (scope, id) => {
        const { outcome: _outcome, ...row } = await actual.sessions.get(scope, id)
        return row
      } } }
    const events: RoutedEvent[] = []
    const failure = await (async () => {
      for await (const event of context.transport.send(context.session, context.turn("Reply with exactly LOSTNOOUTCOME"), context.turnBroker())) events.push(event)
    })().then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ transport: "opencode", code: "engine" })
    expect(events.filter((item) => item.event.type === "error")).toEqual([])
  } finally { target.runtime = actual; await context.close() }
}, 60_000)

test("a turn runs its resolved effort as the variant", async () => {
  const variants = { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } }
  const context = await setupConformance({ name: "opencode-effort", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend, {
      provider: { proof: proofProvider({}, { proof: { ...PROOF_MODEL, variants } }) } }) })
  try {
    const state = context.backend as OpenCodeBackend
    const events = await collect(context, { ...context.turn("Reply with exactly EFFORTHIGH"), effort: "high" })
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    const request = state.server.requests.find((row) => row.prompt.includes("EFFORTHIGH") && row.tools.length)
    expect((request?.body as Record<string, unknown> | undefined)?.reasoning_effort).toBe("high")
  } finally { await context.close() }
}, 60_000)

test("capabilities report each model's effort variants, and accept only those", async () => {
  const variants = { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } }
  const context = await setupConformance({ name: "opencode-effort-levels", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend, {
      provider: { proof: proofProvider({}, { proof: { ...PROOF_MODEL, variants }, plain: { ...PROOF_MODEL, name: "Plain" } }) } }) })
  try {
    const capabilities = await context.transport.capabilities({ directory: context.backend.directory })
    expect(capabilities.effortLevels.status).toBe("resolved")
    expect(harnessEffortVerdict(capabilities.effortLevels, "proof", "high")).toBe("accepted")
    expect(harnessEffortVerdict(capabilities.effortLevels, "proof", "max")).toBe("refused")
    expect(harnessEffortVerdict(capabilities.effortLevels, "plain", "high")).toBe("refused")
  } finally { await context.close() }
}, 60_000)

test("config options name the session's model, a requested model, and a draft's model", async () => {
  const context = await setupConformance({ name: "opencode-config-options", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend, {
      provider: { proof: proofProvider({}, { "proof-mini": { ...PROOF_MODEL, name: "Proof Mini" } }) } }) })
  try {
    const config = context.transport.config!
    const options = (target: Parameters<typeof config.options>[0]) => config.options(target, "probe")
    expect((await options({ session: context.session, model: context.start.model })).resolvedModel).toEqual({ id: "proof/proof", name: "Proof" })
    expect((await options({ session: context.session, model: { providerID: "proof", modelID: "proof-mini" } })).resolvedModel)
      .toEqual({ id: "proof/proof-mini", name: "Proof Mini" })
    const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
    expect((await options({ draft })).resolvedModel).toEqual({ id: "proof/proof", name: "Proof" })
  } finally { await context.close() }
}, 60_000)

test("the owner catalog applies carried custom definitions in a cloud transport and refuses a different owner", async () => {
  const context = await setupConformance({ name: "opencode-custom", backend,
    makeTransport: (services, current) => new OpenCodeSdkTransport(services, {
      databasePath: path.join((current as OpenCodeBackend).root, "opencode.db"),
    }) })
  try {
    const transport = context.transport as OpenCodeSdkTransport
    const definition = { id: "carried", name: "Carried", npm: "@ai-sdk/openai-compatible" as const,
      baseURL: "https://unused.invalid/v1", headers: { "X-Title": "owner" }, models: { carried: { name: "Carried" } }, credentialProviderId: "account", credentialSource: "account" as const }
    const credentials = { ...context.start.credentials, providers: { ...context.start.credentials.providers,
      account: { baseUrl: (context.backend as OpenCodeBackend).server.v1Url, placeholder: "cloud-placeholder", authMode: "api-key" as const } } }
    await transport.configure(context.session, { credentials, providerDefinitions: [definition] })
    const draft = { ...context.start, credentials, providerDefinitions: [definition], locality: "remote" as const }
    const entries = await transport.providerCatalog.providers(draft)
    expect(entries.find((entry) => entry.id === "carried")).toMatchObject({ name: "Carried", connected: true, models: [expect.objectContaining({ id: "carried" })] })
    expect(entries.find((entry) => entry.id === "openai")).toMatchObject({ connected: false, models: [] })
    await expect(transport.providerCatalog.providers({ ...draft, credentials: { ...credentials, accountOwner: "foreign" } })).rejects.toBeInstanceOf(OpenCodeOwnerMismatchError)
    const events: RoutedEvent[] = []
    for await (const event of transport.send(context.session, { ...context.turn("Reply with exactly this one token: CARRIEDTURN"),
      model: { providerID: "carried", modelID: "carried" } }, context.turnBroker())) events.push(event)
    expect(events.some((event) => event.event.type === "text-delta" && event.event.delta.includes("CARRIEDTURN"))).toBe(true)
    expect((context.backend as OpenCodeBackend).server.requests.some((request) => request.authorization === "Bearer cloud-placeholder")).toBe(true)
    await transport.configure(context.session, { providerDefinitions: [] })
    expect((await transport.providerCatalog.providers({ ...draft, providerDefinitions: [] })).some((entry) => entry.id === "carried")).toBe(false)
  } finally { await context.close() }
}, 30_000)

test("OpenCode applies model and effort at the next request without replacing active work", async () => {
  const variants = { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } }
  const context = await setupConformance({ name: "opencode-live-model", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend, {
      provider: { proof: proofProvider({}, { next: { ...PROOF_MODEL, variants } }) }, permission: { shell: "allow" } }) })
  const state = context.backend as OpenCodeBackend
  const release = state.server.holdOpeningReplies("OPENCODELIVEMODEL")
  try {
    state.server.scriptTool({ name: "shell", input: { command: "printf model-boundary" }, whenPromptIncludes: "OPENCODELIVEMODEL" })
    const running = collect(context, context.turn("Run the scripted tool OPENCODELIVEMODEL"))
    await state.server.textGateReached("OPENCODELIVEMODEL")
    await expect(context.transport.config!.setModelSettings!(context.session,
      { model: { providerID: "proof", modelID: "proof" }, effort: "high" })).rejects.toThrow("does not offer effort high")
    await context.transport.config!.setModelSettings!(context.session, { model: { providerID: "proof", modelID: "next" }, effort: "high" })
    release()
    expect(JSON.stringify(await running)).not.toContain('"type":"error"')
    const requests = state.server.requests.filter((request) => request.prompt.includes("OPENCODELIVEMODEL"))
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[0]?.model).toBe("proof")
    expect(requests.at(-1)?.model).toBe("next")
    expect((requests.at(-1)?.body as Record<string, unknown>)?.reasoning_effort).toBe("high")
  } finally { release(); await context.close() }
}, 30_000)

test("a catalog read by another person never takes the engine from the owner who starts its sessions", async () => {
  let prebuilt: OpenCodeSdkTransport | undefined
  const context = await setupConformance({ name: "opencode-catalog-owner", backend: async () => {
    const state = await backend()
    prebuilt = transport(createTestServices(), state)
    const entries = await prebuilt.providerCatalog.providers({ workspaceId: "w1", directory: state.directory, locality: "local",
      owner: { kind: "person", userId: "viewer" }, config: { harness: state.harness, model: state.model }, model: state.model,
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: state.credentials })
    expect(entries.some((entry) => entry.id === "proof" && entry.connected)).toBe(true)
    return state
  }, makeTransport: () => prebuilt! })
  try {
    const events = await collect(context, context.turn("Reply with exactly this one token: OWNERTURN"))
    expect(events.some((event) => event.event.type === "text-delta" && event.event.delta.includes("OWNERTURN"))).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("OpenCode dispose retries an engine whose first close failed, and reports success only once it closed", async () => {
  const context = await setupConformance({ name: "opencode-dispose-retry", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  const runtime = (context.transport as unknown as { runtime: OpenCodeRuntime }).runtime
  const client = await runtime.host.client()
  const close = client.close.bind(client)
  let attempts = 0
  Object.defineProperty(client, "close", { configurable: true, value: async () => {
    attempts += 1
    if (attempts === 1) throw new Error("close refused")
    await close()
  } })
  try {
    await expect(context.transport.dispose()).rejects.toThrow("close refused")
    expect(runtime.host.status().lifecycle).not.toBe("closed")
    await context.transport.dispose()
    expect(attempts).toBe(2)
    expect(runtime.host.status().lifecycle).toBe("closed")
    await context.transport.dispose()
    expect(attempts).toBe(2)
  } finally { await context.close() }
}, 60_000)

for (const machineLoginAllowed of [true, false]) test(`a machine-env provider key is ${machineLoginAllowed ? "spent by a session whose owner may use the machine login" : "refused for anyone else"}`, async () => {
  const context = await setupConformance({ name: `opencode-machine-env-${machineLoginAllowed}`, backend,
    makeTransport: (services, current) => new OpenCodeSdkTransport(services, {
      databasePath: path.join((current as OpenCodeBackend).root, "opencode.db"),
    }) })
  try {
    const server = (context.backend as OpenCodeBackend).server
    const credentials = { ...context.start.credentials, machineLoginAllowed, providers: { ...context.start.credentials.providers,
      envco: { baseUrl: server.v1Url, placeholder: "machine-env-placeholder", authMode: "api-key" as const } } }
    await context.transport.configure(context.session, { credentials, providerDefinitions: [{ id: "envco", name: "Env Co",
      npm: "@ai-sdk/openai-compatible", baseURL: "https://unused.invalid/v1", headers: {}, models: { envco: { name: "Env Co" } },
      credentialProviderId: "envco", credentialSource: "machine-env" }] })
    const events: RoutedEvent[] = []
    const failure = await (async () => {
      for await (const event of context.transport.send(context.session, { ...context.turn("Reply with exactly this one token: MACHINEENV"),
        model: { providerID: "envco", modelID: "envco" } }, context.turnBroker())) events.push(event)
    })().then(() => undefined, (error: unknown) => error)
    if (machineLoginAllowed) {
      expect(failure).toBeUndefined()
      expect(events.some((event) => event.event.type === "text-delta" && event.event.delta.includes("MACHINEENV"))).toBe(true)
      expect(server.requests.some((request) => request.authorization === "Bearer machine-env-placeholder")).toBe(true)
    } else {
      expect(failure).toMatchObject({ code: "credential_unavailable" })
      expect(server.requests.some((request) => request.authorization === "Bearer machine-env-placeholder")).toBe(false)
    }
  } finally { await context.close() }
}, 60_000)

test("a prompt naming a declared OpenCode command runs that command, not its literal text", async () => {
  const context = await setupConformance({ name: "opencode-command", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend, {
      command: { h12: { description: "H12 proof", template: "Reply with exactly this one token: H12COMMAND$ARGUMENTS" } },
    }) })
  try {
    const server = (context.backend as OpenCodeBackend).server
    const declared = await context.transport.commands!.list({ session: context.session })
    expect(declared.map((command) => command.name)).toContain("h12")
    const events = await collect(context, context.turn("/h12 RUN"))
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    const prompts = server.requests.map((request) => request.prompt)
    expect(prompts.some((prompt) => prompt.includes("H12COMMAND RUN") || prompt.includes("H12COMMANDRUN"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("/h12 RUN"))).toBe(false)
  } finally { await context.close() }
}, 60_000)
