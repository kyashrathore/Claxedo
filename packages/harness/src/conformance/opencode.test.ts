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
    execution: "embedded", root, directory, server, expectedMcp: "config",
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

test("one embedded engine refuses a different owner", async () => {
  const context = await setupConformance({ name: "opencode-owner", backend,
    makeTransport: (services, state) => transport(services, state as OpenCodeBackend) })
  try {
    await expect(context.transport.start({ ...context.start, sessionId: "foreign", owner: { kind: "person", userId: "foreign" } },
      context.sessionBroker)).rejects.toBeInstanceOf(OpenCodeOwnerMismatchError)
  } finally { await context.close() }
}, 60_000)

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
