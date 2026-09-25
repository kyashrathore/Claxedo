import { createServer, type Server } from "node:http"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { runConformance, type ConformanceBackend } from "./test-support/run"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { ClaudeSdkTransport } from "../transports/claude-sdk"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority } from "./test-support/memory-ports"
import { createTestServices } from "./test-support/services"
import type { TestServices } from "./test-support/services"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"

type ClaudeBackend = ConformanceBackend & {
  root: string
  configRoot: string
  userConfigRoot: string
  env: NodeJS.ProcessEnv
  attempts: string[]
  sockets: string[]
  samples: Promise<void>[]
  sampledPids: number[]
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
    state.sampledPids.push(owned.pid)
    for (const delay of [25, 250, 750]) state.samples.push(new Promise<void>((resolve, reject) => {
      setTimeout(() => { void sampleSockets(owned.pid, state.sockets).then(resolve, reject) }, delay)
    }))
    return owned
  } }
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
  return {
    root, directory, userConfigRoot, configRoot, env, attempts, sockets, samples, sampledPids, listener, authFile, server,
    owner: { kind: "person", userId: "owner" },
    sharedSender: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    harness: { id: "claude", access: "native" }, expectedMcp: "session",
    model: { providerID: "anthropic", modelID: "default" },
    credentials: { providers: { anthropic: { baseUrl: server.url, placeholder: "claude-conformance-placeholder", authMode: "api-key" } },
      secrets: {}, leaseGeneration: "conformance" },
    hold: (marker) => {
      const release = server.holdTextReplies(marker)
      if (marker === "PISTEER") setTimeout(release, 300)
      return release
    },
    scriptTool: (name, input) => server.scriptTool({ name: name === "read" ? "Read" : name, input: name === "read" ? { file_path: path.join(directory, "conformance.txt") } : input }),
    close: async () => {
      await Promise.all(samples)
      expect(samples).toHaveLength(sampledPids.length * 3)
      process.stdout.write(`CLAUDE_OUTBOUND_ATTEMPTS ${JSON.stringify(attempts)}\n`)
      process.stdout.write(`CLAUDE_SOCKETS ${JSON.stringify({ sampledPids, samples: samples.length, sockets })}\n`)
      listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
      await server.close()
      releasePort(proxyPort)
      releasePort(port)
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

runConformance({
  name: "claude-sdk",
  backend,
  makeTransport(services, state) {
    const claude = state as ClaudeBackend
    return new ClaudeSdkTransport(watchedServices(services, claude), { executable: "claude",
      configRoot: claude.configRoot, userConfigRoot: claude.userConfigRoot, env: claude.env })
  },
})

test.each(["allow_once", "allow_always", "deny"])("Claude permission %s is saved before the tool continues", async (decision) => {
  const state = await backend()
  const services = createTestServices()
  const ports = new MemoryPorts()
  Object.assign(ports, { clock: services.clock })
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = { actor: state.owner, via: "relay" as const, reissued: false }
  const broker = createSessionBroker(owner, { sessionId: "s1", directory: state.directory, workspaceId: "w1", origin })
  const transport = new ClaudeSdkTransport(watchedServices(services, state), { executable: "claude", configRoot: state.configRoot,
    userConfigRoot: state.userConfigRoot, env: state.env })
  try {
    const session = await transport.start({ sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
      config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }, broker)
    ports.current.set("s1", { ...authority, directory: state.directory, upstreamSessionId: session.binding.upstreamSessionId })
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
    expect(pending.upstreamSessionId).toBe(session.binding.upstreamSessionId)
    const answer = await owner.broker.answer(pending.request.requestId, { kind: "permission", decision }, { sessionId: "s1" })
    expect(answer.ok).toBe(true)
    await running
    expect(ports.saved.some((row) => row.pending.request.requestId === pending.request.requestId)).toBe(true)
    expect(await fs.stat(target).then(() => true, () => false)).toBe(decision !== "deny")
    expect(await fs.readFile(path.join(state.userConfigRoot, "settings.json"))).toEqual(originalSettings)
  } finally {
    await transport.dispose()
    await state.close()
  }
}, 60_000)

test("Claude native Goal starts through provider admission and confirms clear", async () => {
  const state = await backend()
  const services = createTestServices()
  const ports = new MemoryPorts()
  let currentGoal: RuntimeGoalSnapshot | null = null
  Object.assign(ports, { readGoal: () => currentGoal, publishGoal: async (_sessionId: string, snapshot: RuntimeGoalSnapshot | null) => {
    currentGoal = snapshot
  } })
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = { actor: state.owner, via: "relay" as const, reissued: false }
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const transport = new ClaudeSdkTransport(watchedServices(services, state), { executable: "claude", configRoot: state.configRoot,
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
    const stopped = await transport.goals.stop(session)
    expect(stopped.ok).toBe(true)
    expect(broker.goal.read()?.status).toBe("paused")
  } finally { release(); await transport.dispose(); await state.close() }
}, 60_000)
