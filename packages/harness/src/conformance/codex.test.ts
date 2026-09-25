import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { runConformance, setupConformance, type ConformanceBackend } from "./test-support/run"
import { ensurePinnedCodex, PINNED_CODEX } from "../../e2e/harness/pinned-codex"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { listenOnLoopback } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { egressProxyEnv, startEgressGuard, unexpectedEgress } from "../../e2e/harness/egress-guard"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import { CodexRpc } from "../transports/codex-app-server/rpc"
import { answerCodexRequest } from "../transports/codex-app-server/requests"
import { prepareCodexProfile } from "../profiles/codex"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority, origin } from "./test-support/memory-ports"
import { createTestServices } from "./test-support/services"
import type { StartInput } from "../contract"

type CodexBackend = ConformanceBackend & {
  root: string
  env: NodeJS.ProcessEnv
  server: Awaited<ReturnType<typeof startScriptedModelServer>>
}

async function backend(): Promise<CodexBackend> {
  await ensurePinnedCodex()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-conformance-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const modelPort = await reservePort()
  const guardPort = await reservePort()
  const server = await startScriptedModelServer({ port: modelPort, red: false })
  const guard = await startEgressGuard(guardPort)
  return {
    root, directory, server, env: { ...process.env, ...egressProxyEnv(guard.url) },
    harness: { id: "codex", access: "native" }, expectedMcp: "config",
    model: { providerID: "codex", modelID: "gpt-4.1" },
    credentials: { providers: { codex: { baseUrl: server.v1Url, placeholder: "codex-conformance-placeholder", authMode: "api-key" } },
      secrets: {}, leaseGeneration: "conformance" },
    owner: { kind: "person", userId: "member" },
    origin: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    hold: (marker) => server.holdTextReplies(marker),
    close: async () => {
      console.log(`Codex outbound attempts: ${JSON.stringify(guard.attempts)}`)
      const unexpected = unexpectedEgress(guard.attempts)
      await guard.close()
      await server.close()
      releasePort(modelPort)
      releasePort(guardPort)
      await fs.rm(root, { recursive: true, force: true })
      expect(unexpected).toEqual([])
    },
  }
}

runConformance({
  name: "codex-app-server",
  backend,
  makeTransport(services, backend) {
    const state = backend as CodexBackend
    return new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env,
    })
  },
})

test("Codex capabilities probe model/list before a session exists", async () => {
  const state = await backend()
  const transport = new CodexAppServerTransport(createTestServices(), {
    binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env,
  })
  try {
    const capabilities = await transport.capabilities({ directory: state.directory })
    expect(capabilities.modelSelection.status).toBe("required")
    if (capabilities.modelSelection.status !== "required") throw new Error("Codex model selection unavailable")
    expect(capabilities.modelSelection.models.length).toBeGreaterThan(0)
    expect(await fs.readdir(path.join(state.root, "homes"))).toEqual([])
  } finally { await transport.dispose(); await state.close() }
}, 60_000)

test("Codex live model list supplies capabilities and session options", async () => {
  const context = await setupConformance({ name: "codex-models", backend,
    makeTransport: (services, state) => new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
    }) })
  try {
    const capabilities = await context.transport.capabilities({ sessionId: "s1", directory: context.backend.directory })
    expect(capabilities.modelSelection.status).toBe("required")
    if (capabilities.modelSelection.status !== "required") throw new Error("Codex model selection unavailable")
    expect(capabilities.modelSelection.models.length).toBeGreaterThan(0)
    expect(capabilities.effortLevels.status).toBe("resolved")
    const options = await context.transport.config!.options({ session: context.session }, "probe")
    expect(options.find((option) => option.id === "model")?.selectOptions?.length).toBeGreaterThan(0)
    expect(options.some((option) => option.id === "effort")).toBe(true)
    expect(options.some((option) => option.id === "service_tier")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("Codex provider-started goal turn is admitted, streams, and settles completed", async () => {
  const context = await setupConformance({ name: "codex-goal-stream", backend,
    makeTransport: (services, state) => new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
    }) })
  let admitted!: (result: Awaited<ReturnType<typeof context.sessionBroker.admitProviderTurn>>) => void
  const admission = new Promise<Awaited<ReturnType<typeof context.sessionBroker.admitProviderTurn>>>((resolve) => { admitted = resolve })
  const original = context.sessionBroker.admitProviderTurn.bind(context.sessionBroker)
  context.sessionBroker.admitProviderTurn = async (input, run) => {
    const result = await original(input, run)
    admitted(result)
    return result
  }
  try {
    expect((await context.transport.goals!.start(context.session, "Reply with GOALSTREAM", context.sessionBroker)).ok).toBe(true)
    const result = await Promise.race([admission, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Goal turn was not admitted")), 10_000))])
    expect(result.admitted).toBe(true)
    if (!result.admitted) throw new Error("Goal turn was refused")
    expect(await result.settled).toEqual({ state: "completed" })
    expect(context.ports.drained.length).toBeGreaterThan(0)
  } finally { await context.close() }
}, 60_000)

test("Codex turn model overrides start model and validates effort and tier from model/list", async () => {
  const frames: { method?: string; params?: Record<string, unknown> }[] = []
  const context = await setupConformance({ name: "codex-model-precedence",
    backend: async () => {
      const state = await backend()
      state.configureServices = (services) => {
        const spawn = services.spawn.bind(services)
        services.spawn = async (command, options) => {
          const owned = await spawn(command, options)
          const write = owned.stdin.write.bind(owned.stdin)
          owned.stdin.write = ((chunk: string) => {
            for (const line of chunk.trim().split("\n")) frames.push(JSON.parse(line))
            return write(chunk)
          }) as typeof owned.stdin.write
          return owned
        }
      }
      return state
    },
    makeTransport: (services, state) => new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
    }) })
  try {
    const options = await context.transport.config!.options({ session: context.session }, "probe")
    const model = options.find((option) => option.id === "model")?.selectOptions?.[0]?.id
    expect(model).toBeDefined()
    const turn = { ...context.turn("MODEL_OVERRIDE"), model: { providerID: "codex", modelID: model! }, effort: "high",
      prompt: { ...context.turn("MODEL_OVERRIDE").prompt, serviceTier: "priority" } }
    const events = []
    for await (const event of context.transport.send(context.session, turn, context.turnBroker())) events.push(event)
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    expect(frames.find((frame) => frame.method === "thread/start")?.params?.model).toBe("gpt-4.1")
    expect(frames.find((frame) => frame.method === "turn/start")?.params).toMatchObject({ model, effort: "high", serviceTier: "priority" })
    const before = frames.filter((frame) => frame.method === "turn/start").length
    await expect((async () => { for await (const _event of context.transport.send(context.session,
      { ...turn, effort: "invalid" }, context.turnBroker())) {} })()).rejects.toThrow("does not run")
    expect(frames.filter((frame) => frame.method === "turn/start")).toHaveLength(before)
  } finally { await context.close() }
}, 60_000)

test("Codex exec approval reaches the durable broker and a denied command never runs", async () => {
  const state = await backend()
  const marker = `/etc/codex-denied-${process.pid}-${Date.now()}`
  state.server.scriptTool({ name: "exec_command", input: { cmd: `touch ${marker}`, sandbox_permissions: "require_escalated", justification: "Test a denied Codex approval" } })
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, { binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env })
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = state.origin!
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: state.credentials }
  try {
    const session = await transport.start(input, broker)
    ports.current.set("s1", { ...authority, directory: state.directory, upstreamSessionId: session.binding.upstreamSessionId })
    const turnBroker = createTurnBroker(owner, { authority: { ...authority, directory: state.directory, upstreamSessionId: session.binding.upstreamSessionId }, origin, signal: new AbortController().signal })
    const received: unknown[] = []
    const running = (async () => { for await (const event of transport.send(session, {
      turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, model: state.model,
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Run the requested command" }] }, todos: [],
    }, turnBroker)) received.push(event.event) })()
    let pending = owner.broker.list({ sessionId: "s1" }).find((item) => item.request.kind === "permission")
    for (let attempt = 0; attempt < 250 && !pending; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      pending = owner.broker.list({ sessionId: "s1" }).find((item) => item.request.kind === "permission")
    }
    expect(pending?.request.kind).toBe("permission")
    if (!pending) throw new Error("Codex did not request approval")
    expect((await owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).ok).toBe(true)
    await running
    expect(received.some((event) => (event as { type?: string }).type === "tool-start")).toBe(true)
    expect(await fs.stat(marker).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")).toBe(false)
  } finally {
    await transport.dispose()
    await state.close()
  }
}, 60_000)

test("Codex native goals use the running app-server", async () => {
  const state = await backend()
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, {
    binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env,
  })
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = state.origin!
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: state.credentials }
  try {
    const session = await transport.start(input, broker)
    const started = await transport.goals.start(session, "Reply with exactly this one token: CODEXGOAL", broker)
    expect(started.ok).toBe(true)
  if (started.ok && started.goal) {
      expect((await transport.goals.read(session))?.objective).toBe(started.goal.objective)
      expect((await transport.goals.pause(session)).ok).toBe(true)
      expect((await transport.goals.resume(session, broker)).ok).toBe(true)
      expect((await transport.goals.stop(session)).ok).toBe(true)
    }
  } finally {
    await transport.dispose()
    await state.close()
  }
}, 60_000)

test("brokered Codex discovers a projected plugin skill through its composed home", async () => {
  const state = await backend()
  const plugin = path.join(state.root, "plugin")
  const skill = path.join(plugin, "skills", "conform-skill")
  await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true })
  await fs.mkdir(skill, { recursive: true })
  await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "conform-plugin", version: "1.0.0", skills: "./skills/" }))
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: conform-skill\ndescription: Conformance plugin\n---\nConformance\n")
  const home = path.join(state.root, "home")
  const projection = { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "one", root: plugin, dataRoot: plugin }] }
  const services = createTestServices()
  let rpc: CodexRpc | undefined
  try {
    await prepareCodexProfile({ home, credentials: state.credentials, projection })
    const owned = await services.spawn({ file: PINNED_CODEX, args: ["app-server", "--listen", "stdio://"], cwd: state.directory,
      env: { ...state.env, CODEX_HOME: home } as Record<string, string> }, { role: "harness", label: "Codex plugin conformance" })
    rpc = new CodexRpc(owned, services.clock)
    await rpc.request("initialize", { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true } })
    rpc.notify("initialized")
    const response = await rpc.request("skills/list", { cwds: [state.directory], forceReload: true })
    expect(JSON.stringify(response)).toContain("conform-skill")
  } finally {
    if (rpc) await rpc.retire({ at: Date.now() + 10_000, signal: new AbortController().signal })
    await state.close()
  }
}, 60_000)

test("Codex starts a projected configured MCP server", async () => {
  const state = await backend()
  const port = await reservePort()
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.writeHead(404).end()
  })
  await listenOnLoopback(server, port)
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, { binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env })
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, directory: state.directory })
  const origin = state.origin!
  const owner = createRequestBroker(ports)
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [
      { name: "projected", kind: "http", url: `http:${String.fromCharCode(47, 47)}127.0.0.1:${port}/mcp`, origin: "configured" },
    ] } }
  try {
    await transport.start(input, broker)
    expect(requests.length).toBeGreaterThan(0)
  } finally {
    await transport.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    releasePort(port)
    await state.close()
  }
}, 60_000)

async function pendingCount(owner: ReturnType<typeof createRequestBroker>, sessionId: string, count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = owner.broker.list({ sessionId })
    if (rows.length === count) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${count} pending Codex requests for ${sessionId}`)
}

test("Codex native request IDs are unique across processes and answers stay in their sessions", async () => {
  const ports = new MemoryPorts()
  ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2" })
  ports.directories.set("s2", "/work")
  const owner = createRequestBroker(ports)
  const first = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
  const second = createTurnBroker(owner, { authority: { ...authority, sessionId: "s2", workspaceId: "w2" }, origin,
    signal: new AbortController().signal })
  const question = { id: 0, method: "item/tool/requestUserInput", params: { questions: [{ id: "answer", question: "Choose" }] } }
  const one = answerCodexRequest(question, first, "s1")
  const two = answerCodexRequest(question, second, "s2")
  const [row1] = await pendingCount(owner, "s1", 1)
  const [row2] = await pendingCount(owner, "s2", 1)
  expect(row1?.request.requestId).not.toBe(row2?.request.requestId)
  expect((await owner.broker.answer(row1!.request.requestId, { kind: "answers", answers: [["one"]] }, { sessionId: "s1" })).ok).toBe(true)
  expect((await owner.broker.answer(row2!.request.requestId, { kind: "answers", answers: [["two"]] }, { sessionId: "s2" })).ok).toBe(true)
  expect(await one).toEqual({ answers: { answer: { answers: ["one"] } } })
  expect(await two).toEqual({ answers: { answer: { answers: ["two"] } } })
})

test("Codex persistent approval grants reapply only to the same session, directory, mode, and command", async () => {
  const ports = new MemoryPorts()
  const owner = createRequestBroker(ports)
  const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
  const context = { directory: "/work", permissionMode: "default" }
  const command = { id: 0, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1, command: "echo hello", cwd: "/work",
  } }
  const first = answerCodexRequest(command, turn, "s1", context)
  const [pending] = await pendingCount(owner, "s1", 1)
  expect((await owner.broker.answer(pending!.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).ok).toBe(true)
  expect(await first).toEqual({ decision: "acceptForSession" })
  ports.current.set("s1", { ...authority, turnId: "replacement-turn" })
  const replacement = createTurnBroker(owner, { authority: { ...authority, turnId: "replacement-turn" }, origin,
    signal: new AbortController().signal })
  const same = { ...command, params: { ...command.params, turnId: "new-turn", itemId: "new-item" } }
  expect(await answerCodexRequest(same, replacement, "s1", context)).toEqual({ decision: "acceptForSession" })
  const variants = [
    { frame: { ...same, params: { ...same.params, command: "echo changed" } }, context },
    { frame: same, context: { ...context, directory: "/other" } },
    { frame: same, context: { ...context, permissionMode: "restricted" } },
    { frame: { ...same, params: { ...same.params, additionalPermissions: ["network"] } }, context },
  ]
  for (const variant of variants) {
    const asked = answerCodexRequest(variant.frame, replacement, "s1", variant.context)
    const [row] = await pendingCount(owner, "s1", 1)
    expect((await owner.broker.answer(row!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).ok).toBe(true)
    expect(await asked).toEqual({ decision: "decline" })
  }
  ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2" })
  ports.directories.set("s2", "/work")
  const foreign = createTurnBroker(owner, { authority: { ...authority, sessionId: "s2", workspaceId: "w2" }, origin,
    signal: new AbortController().signal })
  const otherSession = answerCodexRequest(same, foreign, "s2", context)
  const [other] = await pendingCount(owner, "s2", 1)
  expect((await owner.broker.answer(other!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s2" })).ok).toBe(true)
  expect(await otherSession).toEqual({ decision: "decline" })
  for (const decision of ["allow_once", "deny", "reject_always"] as const) {
    const frame = { ...same, params: { ...same.params, command: `echo ${decision}` } }
    const asked = answerCodexRequest(frame, replacement, "s1", context)
    const [row] = await pendingCount(owner, "s1", 1)
    expect((await owner.broker.answer(row!.request.requestId, { kind: "permission", decision }, { sessionId: "s1" })).ok).toBe(true)
    await asked
    const retry = answerCodexRequest({ ...frame, params: { ...frame.params, turnId: `after-${decision}` } }, replacement, "s1", context)
    const [again] = await pendingCount(owner, "s1", 1)
    expect((await owner.broker.answer(again!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).ok).toBe(true)
    expect(await retry).toEqual({ decision: "decline" })
  }
})
