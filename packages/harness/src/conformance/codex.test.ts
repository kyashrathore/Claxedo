import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { runConformance, type ConformanceBackend } from "./test-support/run"
import { ensurePinnedCodex, PINNED_CODEX } from "../../e2e/harness/pinned-codex"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { listenOnLoopback } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { egressProxyEnv, startEgressGuard, unexpectedEgress } from "../../e2e/harness/egress-guard"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import { CodexRpc } from "../transports/codex-app-server/rpc"
import { prepareCodexProfile } from "../profiles/codex"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority } from "./test-support/memory-ports"
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
    for (let attempt = 0; attempt < 100 && !pending; attempt++) {
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
