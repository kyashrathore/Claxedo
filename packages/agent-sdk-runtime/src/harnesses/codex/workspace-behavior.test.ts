import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"
import { removeTestTempDir } from "../shared/test-temp-dir"
import fs from "fs"
import os from "os"
import path from "path"
import { CodexHarnessAdapter } from "./index"
import type { PromptInput, SessionConfig } from "../../index"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { fakeRuntimeStore } from "../../test-utils/fake-runtime-store"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { createAgentRuntime, type AgentHarnessFactory } from "../../runtime"
import type { AgentHarnessFactoryContext } from "../../runtime/contracts"
import { createSqliteRuntimeStore } from "../../stores/sqlite"
import { isTerminalRuntimePayload } from "../../runtime/turn-outcome"

const tempDirs: string[] = []

// Isolate test credentials from the developer's Codex home.
let previousCodexHome: string | undefined
let codexHomeGuard: string | undefined
beforeAll(() => {
  previousCodexHome = process.env.CODEX_HOME
  codexHomeGuard = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-guard-"))
  process.env.CODEX_HOME = codexHomeGuard
})
afterAll(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  if (codexHomeGuard) await fs.promises.rm(codexHomeGuard, { recursive: true, force: true })
})

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) removeTestTempDir(dir)
})

/** Session/config state the Codex adapter round-trips through the complete test store. */
function fakeCodexStore(): AgentRuntimeStoreWithRecovery {
  const sessions = new Map<string, { id: string; directory: string; title?: string }>()
  const configs = new Map<string, SessionConfig>()
  const agentSessionIds = new Map<string, string>()

  return fakeRuntimeStore({
    bindSession(input) {
      sessions.set(input.sessionId, { id: input.sessionId, directory: input.directory, title: input.title })
      agentSessionIds.set(input.sessionId, input.agentSessionId)
    },
    getAgentSessionId: (id) => agentSessionIds.get(id),
    getSession: (id) => sessions.get(id) ?? null,
    updateSessionConfig(id, update) {
      const next = { ...configs.get(id), ...update } as SessionConfig
      configs.set(id, next)
      return next
    },
    getSessionConfig: (id) => configs.get(id),
  })
}

/**
 * Windows cannot execute a shebang script, so there the fake is a .cmd shim
 * delegating to node — the same launcher shape a real npm install of codex
 * puts on PATH, which `resolveHarnessCommand` unwraps to the script it names.
 */
async function installFakeBinary(dir: string, script: string): Promise<string> {
  if (process.platform !== "win32") {
    const binary = path.join(dir, "codex")
    await fs.promises.writeFile(binary, `#!/usr/bin/env node\n${script}`, "utf8")
    await fs.promises.chmod(binary, 0o755)
    return binary
  }
  const implementation = path.join(dir, "codex-impl.cjs")
  await fs.promises.writeFile(implementation, script, "utf8")
  const binary = path.join(dir, "codex.cmd")
  await fs.promises.writeFile(binary, `@echo off\r\nnode "%~dp0codex-impl.cjs" %*\r\n`, "utf8")
  return binary
}

async function makeFakeCodex(options: {
  imageViewPath?: string
  requestRefresh?: boolean
  mcpElicitation?: boolean
  mcpConsent?: boolean
  auth401?: boolean
  models?: unknown[]
  subagent?: boolean
  subagentActivity?: boolean
  initializeDelayMs?: number
  loginDelayMs?: number
  ignoreSigterm?: boolean
} = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-app-server-"))
  tempDirs.push(dir)
  const log = path.join(dir, "requests.ndjson")
  const binary = await installFakeBinary(dir, `
const fs = require("fs")
const imageViewPath = ${JSON.stringify(options.imageViewPath ?? null)}
const logPath = ${JSON.stringify(log)}
const requestRefresh = ${JSON.stringify(options.requestRefresh === true)}
const mcpElicitation = ${JSON.stringify(options.mcpElicitation === true)}
const mcpConsent = ${JSON.stringify(options.mcpConsent === true)}
const auth401 = ${JSON.stringify(options.auth401 === true)}
const subagent = ${JSON.stringify(options.subagent === true)}
const subagentActivity = ${JSON.stringify(options.subagentActivity === true)}
const initializeDelayMs = ${JSON.stringify(options.initializeDelayMs ?? 0)}
const loginDelayMs = ${JSON.stringify(options.loginDelayMs ?? 0)}
const ignoreSigterm = ${JSON.stringify(options.ignoreSigterm === true)}
const models = ${JSON.stringify(options.models ?? [])}
let buffer = ""
let completed = false
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}
function append(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\\n")
}
append({ event: "started", pid: process.pid, codexHome: process.env.CODEX_HOME })
process.on("SIGTERM", () => {
  append({ event: "sigterm" })
  if (ignoreSigterm) return
  process.exit(0)
})
function completeTurn() {
  if (completed) return
  completed = true
  if (imageViewPath) {
    const item = { type: "imageView", id: "view-1", path: imageViewPath }
    write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item } })
    write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } })
  }
  write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "assistant-1", delta: "OK" } })
  write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "assistant-1", type: "agentMessage", text: "OK" } } })
  write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (true) {
    const i = buffer.indexOf("\\n")
    if (i < 0) return
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.id) append(message)
    if ((message.id === 900 || message.id === 901) && message.result) completeTurn()
    if (message.id === 901 && message.error && Number.isInteger(message.error.code) && typeof message.error.message === "string") completeTurn()
    if (message.method === "initialize") {
      setTimeout(() => write({ id: message.id, result: { userAgent: "fake-codex" } }), initializeDelayMs)
    }
    if (message.method === "account/login/start") {
      setTimeout(() => write({ id: message.id, result: { type: "chatgptAuthTokens" } }), loginDelayMs)
    }
    if (message.method === "account/logout") {
      write({ id: message.id, result: {} })
    }
    if (message.method === "model/list") {
      write({ id: message.id, result: { data: models, nextCursor: null } })
    }
    if (message.method === "thread/start") {
      write({ id: message.id, result: { thread: { id: "thread-1" } } })
      write({ method: "thread/started", params: { thread: { id: "thread-1" } } })
    }
    if (message.method === "thread/archive") {
      write({ id: message.id, result: {} })
    }
    if (message.method === "thread/goal/clear") {
      write({ id: message.id, result: { cleared: false } })
    }
    if (message.method === "turn/start") {
      if (auth401) {
        process.stderr.write("failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses\\n")
        return
      }
      write({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } })
      write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } })
      if (subagentActivity) {
        const item = { id: "activity-spawn", type: "subAgentActivity", kind: "started", agentThreadId: "activity-child", agentPath: "/root/child" }
        write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item } })
        write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } })
        write({ method: "item/agentMessage/delta", params: { threadId: "activity-child", turnId: "child-turn", itemId: "child-message", delta: "ACTIVITY-CHILD-ONLY" } })
        write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { ...item, id: "activity-completed", kind: "completed" } } })
      }
      if (subagent) {
        write({ method: "thread/started", params: { thread: { id: "thread-child-1", parentThreadId: "thread-1", preview: "Research one", agentNickname: "Alpha", agentRole: "researcher", status: { type: "active", activeFlags: [] } } } })
        write({ method: "thread/started", params: { thread: { id: "thread-child-2", parentThreadId: "thread-1", preview: "Research two", agentNickname: "Beta", agentRole: "researcher", status: { type: "active", activeFlags: [] } } } })
        write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress", senderThreadId: "thread-1", receiverThreadIds: ["thread-child-1", "thread-child-2"], prompt: "Research both", model: "gpt-5.5", agentsStates: { "thread-child-1": { status: "running", message: null }, "thread-child-2": { status: "pendingInit", message: null } } } } })
        write({ method: "item/agentMessage/delta", params: { threadId: "thread-child-1", turnId: "child-turn-1", itemId: "child-message-1", delta: "CHILD-ONLY" } })
        write({ method: "item/agentMessage/delta", params: { threadId: "thread-child-2", turnId: "child-turn-2", itemId: "child-message-2", delta: "SECOND-CHILD-ONLY" } })
        write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", senderThreadId: "thread-1", receiverThreadIds: ["thread-child-1", "thread-child-2"], prompt: "Research both", model: "gpt-5.5", agentsStates: { "thread-child-1": { status: "running", message: null }, "thread-child-2": { status: "running", message: null } } } } })
        write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "send-1", type: "collabAgentToolCall", tool: "sendInput", status: "inProgress", senderThreadId: "thread-1", receiverThreadIds: ["thread-child-1"], prompt: "Continue", model: null, agentsStates: { "thread-child-1": { status: "completed", message: null } } } } })
        write({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "close-1", type: "collabAgentToolCall", tool: "closeAgent", status: "completed", senderThreadId: "thread-1", receiverThreadIds: ["thread-child-2"], prompt: null, model: null, agentsStates: { "thread-child-2": { status: "shutdown", message: null } } } } })
      }
      if (requestRefresh) {
        write({ id: 900, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "acct-1" } })
      } else if (mcpConsent) {
        write({ id: 901, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "cua_repl", mode: "form", message: "Allow Computer Use?", _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] }, requestedSchema: { type: "object", properties: {} } } })
      } else if (mcpElicitation) {
        write({ id: 901, method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "composio", mode: "url", message: "Connect Gmail", elicitationId: "connect-1", url: "https://example.test/connect" } })
      } else {
        completeTurn()
      }
    }
  }
})
`)
  return { dir, binary, log }
}

async function waitForLog(log: string, match: (row: Record<string, unknown>) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await fs.promises.readFile(log, "utf8")
      .then((value) => value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>), () => [])
    if (rows.some(match)) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for fake Codex log ${log}`)
}

/**
 * Deliberately shorter than a retirement's TERM-then-KILL escalation: by the
 * time disposal resolves, the process it owned is already gone. A budget wide
 * enough to cover the escalation would pass even if disposal went back to
 * returning while its retirement ran on in the background.
 */
async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for fake Codex process ${pid} to exit`)
}

function prompt(modelID: string, variant?: string): PromptInput {
  return {
    parts: [{ type: "text", text: "Reply with exactly OK." }],
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    agent: "build",
    model: { providerID: "codex-app-server", modelID },
    ...(variant ? { variant } : {}),
  }
}

function codexModel(efforts: string[], defaultEffort: string) {
  return {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Frontier model",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: defaultEffort,
  }
}

async function runWithModels(input: {
  globalModel: string
  promptModel?: string
}) {
  const fake = await makeFakeCodex()
  const adapter = new CodexHarnessAdapter({
    binary: fake.binary,
    createStore: () => fakeCodexStore(),
    storeRoot: path.join(fake.dir, "store"),
  })
  adapter.setModel(input.globalModel)
  const session = await adapter.createSession(fake.dir)
  for await (const _event of executeTestTurn(adapter, session.id, prompt(input.promptModel ?? input.globalModel), fake.dir)) {}
  await adapter.dispose()
  return fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    method: string
    params?: Record<string, unknown>
  })
}

async function runWithModel(model: string) {
  return runWithModels({ globalModel: model })
}

test("public Codex first turn uses the created upstream thread and persists history under the local session", async () => {
  const fake = await makeFakeCodex()
  const root = path.join(fake.dir, "public-runtime-store")
  const store = createSqliteRuntimeStore({ root })
  const rows = store
  const runtime = createAgentRuntime({
    store,
    harnesses: [{
      id: "codex", access: "native",
      create: ({ eventHub }: AgentHarnessFactoryContext) => new CodexHarnessAdapter({ store: rows, eventHub, binary: fake.binary, codexHome: fake.dir }),
    } as unknown as AgentHarnessFactory],
  })
  const sessionId = "local-codex-session"
  try {
    await runtime.sessions.create({
      id: sessionId, workspaceId: "workspace-codex", directory: fake.dir,
      harness: { id: "codex", access: "native" }, model: { providerID: "codex", modelID: "gpt-5.5" },
    })
    expect(rows.getExecutionBinding(sessionId)).toMatchObject({
      sessionId, workspaceId: "workspace-codex", directory: fake.dir,
      connectionId: "native:codex", upstreamSessionId: "thread-1",
    })
    const completed = (async () => {
      for await (const event of runtime.events.subscribe({ sessionId })) {
        expect(event.sessionId).toBe(sessionId)
        if (isTerminalRuntimePayload(event.payload)) {
          expect(event.payload.type).toBe("session.idle")
          break
        }
      }
    })()
    await runtime.turns.start({ sessionId, messageId: "local-user", text: "Hello" })
    await completed
    const history = await runtime.events.list(sessionId, fake.dir)
    expect(history.every((message) => message.info.sessionID === sessionId)).toBe(true)
    expect(JSON.stringify(history)).toContain("OK")
    expect(rows.getSession("thread-1")).toBeNull()
    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1)
    expect(requests.filter((request) => request.method === "turn/start")).toMatchObject([{ params: { threadId: "thread-1" } }])
  } finally {
    await runtime.dispose()
    rows.close?.()
  }
  const reopened = createSqliteRuntimeStore({ root })
  try {
    expect(reopened.getExecutionBinding(sessionId)?.upstreamSessionId).toBe("thread-1")
    expect(JSON.stringify(reopened.getMessages(sessionId))).toContain("OK")
  } finally { reopened.close?.() }
})

describe("CodexHarnessAdapter", () => {
  test("stores the native image reference without copying or changing it after source deletion", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-viewed-image-"))
    tempDirs.push(scratch)
    const source = path.join(scratch, "shot.png")
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
    fs.writeFileSync(source, bytes)
    const fake = await makeFakeCodex({ imageViewPath: source })
    const store = createMemoryRuntimeStore()
    const adapter = new CodexHarnessAdapter({ binary: fake.binary, store, storeRoot: path.join(fake.dir, "store") })
    try {
      const session = await adapter.createSession(fake.dir)
      let sawCompletion = false
      for await (const event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) {
        if (event.type !== "message.part.updated") continue
        const part = event.properties.part
        if (part.type !== "tool" || part.tool !== "view_image" || part.state.status !== "completed") continue
        const file = part.state.attachments?.[0]
        expect(file?.location).toEqual({ kind: "tool-file", path: source })
        expect(fs.existsSync(path.join(fake.dir, ".claxedo", "attachments"))).toBe(false)
        sawCompletion = true
      }
      expect(sawCompletion).toBe(true)
      const before = JSON.stringify(store.getMessages(session.id))
      fs.unlinkSync(source)
      expect(JSON.stringify(store.getMessages(session.id))).toBe(before)
      expect(JSON.stringify(store.getMessages(session.id))).toContain('"filename":"shot.png"')
      expect(JSON.stringify(store.getMessages(session.id))).toContain('"kind":"tool-file"')
    } finally {
      await adapter.dispose()
    }
  })

  test("shares one app-server startup across concurrent session creation and model discovery", async () => {
    const fake = await makeFakeCodex({
      models: [codexModel(["low", "high"], "low")],
    })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")

    await Promise.all([
      adapter.createSession(fake.dir),
      adapter.probeConfigOptions(fake.dir),
    ])
    await adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method: string
    })
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1)
  })

  const brokerProjection = {
    baseUrl: "http://127.0.0.1:2595/bindings/9ab1",
    placeholder: "signed-placeholder",
    authMode: "bearer" as const,
    expiresAt: 1_800_000_000_000,
    apiPath: "/backend-api/codex",
  }

  /** The homes the app-servers this fake launched were given; none when it never ran. */
  function launchedHomes(log: string) {
    if (!fs.existsSync(log)) return []
    return fs.readFileSync(log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { event?: string; codexHome?: string })
      .flatMap((row) => row.event === "started" && row.codexHome ? [row.codexHome] : [])
  }

  test("a projection for another harness leaves Codex on the operator's own login", async () => {
    const fake = await makeFakeCodex({})
    const operatorHome = path.join(fake.dir, "operator-home")
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
      codexHome: operatorHome,
      brokeredHome: path.join(fake.dir, "brokered-home"),
    })

    await adapter.applyConfig({ auth: { "claude-sdk": brokerProjection } })
    await adapter.createSession(fake.dir)
    await adapter.dispose()

    expect(launchedHomes(fake.log)).toEqual([operatorHome])
    expect(fs.existsSync(path.join(fake.dir, "brokered-home"))).toBe(false)
  })

  test("a bound Codex account launches on a Claxedo home carrying the placeholder", async () => {
    const fake = await makeFakeCodex({})
    const operatorHome = path.join(fake.dir, "operator-home")
    const brokeredHome = path.join(fake.dir, "brokered-home")
    fs.mkdirSync(operatorHome, { recursive: true })
    fs.writeFileSync(path.join(operatorHome, "auth.json"), '{"tokens":{"access_token":"operator-own"}}')
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
      codexHome: operatorHome,
      brokeredHome,
    })

    await adapter.applyConfig({ auth: { "codex-app-server": brokerProjection } })
    await adapter.createSession(fake.dir)
    await adapter.dispose()

    expect(launchedHomes(fake.log)).toEqual([brokeredHome])
    expect(fs.readdirSync(brokeredHome)).toEqual(["config.toml"])
    const config = fs.readFileSync(path.join(brokeredHome, "config.toml"), "utf8")
    expect(config).toContain('base_url = "http://127.0.0.1:2595/bindings/9ab1/backend-api/codex"')
    expect(config).toContain('http_headers = { Authorization = "Bearer signed-placeholder" }')
    expect(config).toContain("requires_openai_auth = false")
    expect(config).toContain('wire_api = "responses"')
    expect(config).not.toContain("operator-own")

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method?: string
      params?: { modelProvider?: string }
    })
    expect(requests.some((request) => request.method === "account/login/start")).toBe(false)
    expect(requests.find((request) => request.method === "thread/start")?.params?.modelProvider).toBe("broker")
  })

  test("a renewed placeholder relaunches the app-server on it; the same one keeps the running process", async () => {
    const fake = await makeFakeCodex({})
    const brokeredHome = path.join(fake.dir, "brokered-home")
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
      codexHome: path.join(fake.dir, "operator-home"),
      brokeredHome,
    })

    await adapter.applyConfig({ auth: { "codex-app-server": brokerProjection } })
    await adapter.createSession(fake.dir)
    expect(launchedHomes(fake.log)).toEqual([brokeredHome])

    await adapter.applyConfig({ auth: { "codex-app-server": { ...brokerProjection } } })
    await adapter.createSession(fake.dir)
    expect(launchedHomes(fake.log)).toEqual([brokeredHome])

    // A live process holds the placeholder it started with, and the broker
    // stops answering that one when it is renewed.
    await adapter.applyConfig({ auth: { "codex-app-server": { ...brokerProjection, placeholder: "renewed-placeholder" } } })
    await adapter.createSession(fake.dir)
    await adapter.dispose()

    expect(launchedHomes(fake.log)).toEqual([brokeredHome, brokeredHome])
    expect(fs.readFileSync(path.join(brokeredHome, "config.toml"), "utf8"))
      .toContain('http_headers = { Authorization = "Bearer renewed-placeholder" }')
  })

  test("an unavailable account fails the launch instead of falling back to the machine login", async () => {
    const fake = await makeFakeCodex({})
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
      codexHome: path.join(fake.dir, "operator-home"),
      brokeredHome: path.join(fake.dir, "brokered-home"),
    })

    await adapter.applyConfig({ auth: { "codex-app-server": { unavailable: true, reason: "auth_failed" } } })
    await expect(adapter.createSession(fake.dir))
      .rejects.toThrow("the codex credential selected for this workspace cannot be used: auth_failed")
    await adapter.dispose()

    expect(launchedHomes(fake.log)).toEqual([])
  })

  test("disposes an app-server whose startup is still pending", async () => {
    const fake = await makeFakeCodex({ initializeDelayMs: 10_000, ignoreSigterm: true })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })

    const creation = adapter.createSession(fake.dir)
    await waitForLog(fake.log, (row) => row.method === "initialize")
    const pid = fs.readFileSync(fake.log, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { event?: string; pid?: number })
      .find((row) => row.event === "started")?.pid
    if (!pid) throw new Error("Fake Codex process did not record its PID")
    await adapter.dispose()

    await expect(creation).rejects.toThrow()
    // The sigterm log row comes from the fake's POSIX signal handler. Windows
    // dispose is TerminateProcess on the whole tree — no handler ever runs, so
    // the observable contract there is only that the real process is gone.
    if (process.platform !== "win32") {
      await waitForLog(fake.log, (row) => row.event === "sigterm")
    }
    await waitForProcessExit(pid)
  })

  test("omits Codex app-server default model from provider requests", async () => {
    const requests = await runWithModel("default")

    expect("model" in requests.find((request) => request.method === "thread/start")!.params!).toBe(false)
    expect("model" in requests.find((request) => request.method === "turn/start")!.params!).toBe(false)
  })

  test("passes explicit Codex app-server models through to provider requests", async () => {
    const requests = await runWithModel("gpt-5.5")

    expect(requests.find((request) => request.method === "thread/start")!.params?.model).toBe("gpt-5.5")
    expect(requests.find((request) => request.method === "turn/start")!.params?.model).toBe("gpt-5.5")
  })

  test("installs a cross-harness transcript before the first Codex turn", async () => {
    const fake = await makeFakeCodex()
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })
    const transcript = '<session-handoff from="claude">\nUser:\nMy dog is Tommy.\n</session-handoff>'

    await adapter.createHandoffSession(fake.dir, undefined, "ses_handoff", { system: transcript })
    await adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method?: string
      params?: Record<string, unknown>
    })
    expect(requests.find((request) => request.method === "thread/start")?.params?.developerInstructions).toBe(transcript)
  })

  test("archives a prepared Codex thread when handoff rollback runs", async () => {
    const fake = await makeFakeCodex()
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })

    const prepared = await adapter.createHandoffSession(fake.dir, undefined, "ses_handoff", { system: "handoff" })
    await prepared.rollback()
    await prepared.rollback()
    await adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
    })
    expect(requests.filter((request) => request.method === "thread/archive")).toEqual([{
      id: expect.any(Number),
      method: "thread/archive",
      params: { threadId: "thread-1" },
    }])
  })

  test("uses prompt session model before workspace-global model for Codex app-server turns", async () => {
    const requests = await runWithModels({
      globalModel: "gpt-5.5",
      promptModel: "gpt-5.4",
    })

    expect(requests.find((request) => request.method === "thread/start")!.params?.model).toBe("gpt-5.5")
    expect(requests.find((request) => request.method === "turn/start")!.params?.model).toBe("gpt-5.4")
  })

  test("exposes each Codex model's supported reasoning efforts as a config option", async () => {
    const fake = await makeFakeCodex({
      models: [codexModel(["low", "high", "xhigh"], "high")],
    })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")

    expect((await adapter.probeConfigOptions(fake.dir)).options).toContainEqual({
      id: "effort",
      name: "Effort",
      description: "How much reasoning effort the model should use",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      selectOptions: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
        { id: "xhigh", name: "Xhigh" },
      ],
    })
    await adapter.dispose()
  })

  test("passes the selected reasoning effort to Codex turn/start", async () => {
    const fake = await makeFakeCodex({
      models: [codexModel(["minimal", "high"], "high")],
    })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")
    await adapter.probeConfigOptions(fake.dir)
    const session = await adapter.createSession(fake.dir)
    for await (const _event of executeTestTurn(adapter, session.id, prompt("gpt-5.5", "minimal"), fake.dir)) {}
    await adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method: string
      params?: Record<string, unknown>
    })
    expect(requests.find((request) => request.method === "turn/start")!.params?.effort).toBe("minimal")
  })

  test("answers the app-server refresh request from its own ChatGPT auth file", async () => {
    const fake = await makeFakeCodex({ requestRefresh: true })
    const refreshBodies: string[] = []
    const codexHome = path.join(fake.dir, "codex-home")
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      // Isolate refresh writes from the developer's Codex home.
      codexHome,
      fetch: async (_url, init) => {
        refreshBodies.push(typeof init?.body === "string" ? init.body : "")
        return Response.json({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          id_token: "fresh-id-token",
          account_id: "acct-2",
        })
      },
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "stale-access-token",
        refresh_token: "stale-refresh-token",
        account_id: "acct-1",
      },
    }))

    const session = await adapter.createSession(fake.dir)
    for await (const _event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) {}
    await adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: Record<string, unknown>
    })
    expect(refreshBodies[0]).toContain("refresh_token=stale-refresh-token")
    expect(requests.find((request) => request.id === 900 && request.result)?.result).toEqual({
      accessToken: "fresh-access-token",
      chatgptAccountId: "acct-2",
      chatgptPlanType: null,
    })

    // The refreshed credential must persist id_token — codex (>=0.143) refuses to
    // parse auth.json without it — and must land in the isolated home, not real ~/.codex.
    const persisted = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"))
    expect(persisted.tokens.id_token).toBe("fresh-id-token")
    expect(persisted.tokens.access_token).toBe("fresh-access-token")
    expect(persisted.tokens.refresh_token).toBe("fresh-refresh-token")
  })

  test("an approval storage failure replies to the provider and does not strand the public turn", async () => {
    const fake = await makeFakeCodex({ mcpConsent: true })
    const store = createMemoryRuntimeStore()
    const append = store.appendEvent.bind(store)
    store.appendEvent = (input) => {
      if (input.payload.type === "permission.asked") throw new Error("permission storage unavailable")
      return append(input)
    }
    const adapter = new CodexHarnessAdapter({ binary: fake.binary, store, storeRoot: path.join(fake.dir, "store") })
    adapter.setModel("gpt-5.5")
    try {
      const session = await adapter.createSession(fake.dir)
      const events = []
      for await (const event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) events.push(event)
      expect(events.some((event) => event.type === "session.idle")).toBe(true)
      expect(await adapter.listPermissions(fake.dir)).toEqual([])
      const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      expect(requests.find((row) => row.id === 901 && row.error)?.error).toEqual({ code: -32603, message: "permission storage unavailable" })
      expect(requests.some((row) => row.id === 901 && row.result)).toBe(false)
    } finally {
      await adapter.dispose()
    }
  })

  for (const optionId of ["accept", "decline", "cancel", '{"persist":"session"}', '{"persist":"always"}']) {
    test(`MCP consent preserves the advertised choice ${optionId}`, async () => {
      const fake = await makeFakeCodex({ mcpConsent: true })
      const adapter = new CodexHarnessAdapter({ binary: fake.binary, store: createMemoryRuntimeStore(), storeRoot: path.join(fake.dir, "store") })
      adapter.setModel("gpt-5.5")
      const session = await adapter.createSession(fake.dir)
      const turn = (async () => {
        for await (const _event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) {}
      })()
      try {
        let permission: Awaited<ReturnType<typeof adapter.listPermissions>>[number] | undefined
        for (let attempt = 0; attempt < 200; attempt++) {
          permission = (await adapter.listPermissions(fake.dir)).find((item) => item.sessionID === session.id)
          if (permission) break
          await Bun.sleep(5)
        }
        expect(structuredClone(permission)).toMatchObject({ permission: "cua_repl", metadata: { reason: "Allow Computer Use?" }, options: expect.arrayContaining([{ id: optionId, label: expect.any(String) }]) })
        expect(await adapter.listQuestions(fake.dir)).toEqual([])
        expect(permission!.id).not.toBe("901")
        await adapter.respondPermission(executionBinding(session.id, fake.dir), permission!.id, "allow_once", optionId)
        await turn
        expect(await adapter.listPermissions(fake.dir)).toEqual([])
        await waitForLog(fake.log, (row) => row.id === 901 && !!row.result)
        const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        const persist = optionId.startsWith("{") ? JSON.parse(optionId).persist : undefined
        expect(requests.find((row) => row.id === 901 && row.result)?.result).toEqual({
          action: persist ? "accept" : optionId, content: persist || optionId === "accept" ? {} : null, _meta: persist ? { persist } : null,
        })
      } finally {
        await adapter.dispose()
      }
    })
  }

  test("projects MCP URL elicitations as questions and returns the user's acceptance", async () => {
    const fake = await makeFakeCodex({ mcpElicitation: true })
    const store = createMemoryRuntimeStore()
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      store,
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")
    const session = await adapter.createSession(fake.dir)
    const turn = (async () => {
      for await (const _event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) {}
    })()

    let question: Awaited<ReturnType<typeof adapter.listQuestions>>[number] | undefined
    for (let attempt = 0; attempt < 200; attempt++) {
      question = (await adapter.listQuestions(fake.dir)).find((item) => item.sessionID === session.id)
      if (question) break
      await Bun.sleep(5)
    }
    expect(structuredClone(question)).toMatchObject({
      id: expect.any(String),
      sessionID: session.id,
      questions: [{
        header: "Connect composio",
        question: "Connect Gmail\n\nOpen this authorization URL in your browser, finish connecting, then continue:\nhttps://example.test/connect",
        options: [{ label: "I've finished connecting", description: "Continue after the authorization page confirms the connection." }],
        custom: false,
      }],
    })

    expect(question!.id).not.toBe("901")
    await adapter.replyQuestion(executionBinding(session.id, fake.dir), question!.id, [["I've finished connecting"]])
    await turn
    await adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      id?: number
      result?: Record<string, unknown>
    })
    expect(requests.find((request) => request.id === 901 && request.result)?.result).toEqual({ action: "accept" })
  })

  test("fails Codex turns on provider auth 401 stderr instead of hanging", async () => {
    const fake = await makeFakeCodex({ auth401: true })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")

    const session = await adapter.createSession(fake.dir)
    const events = []
    for await (const event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) events.push(event)
    await adapter.dispose()

    expect(events.some((event) => JSON.stringify(event).includes("Codex authentication failed with 401 Unauthorized"))).toBe(true)
  })

  test("admits native subAgentActivity once and routes its child transcript separately", async () => {
    const fake = await makeFakeCodex({ subagentActivity: true })
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const store = createMemoryRuntimeStore()
    const adapter = new CodexHarnessAdapter({ binary: fake.binary, eventHub, store, storeRoot: path.join(fake.dir, "store") })
    try {
      const session = await adapter.createSession(fake.dir)
      for await (const _event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) {}
      const children = store.listSessions(fake.dir).filter((item) => item.parentID === session.id)
      expect(children).toHaveLength(1)
      expect(JSON.stringify(store.getMessages(children[0].id))).toContain("ACTIVITY-CHILD-ONLY")
      expect(JSON.stringify(store.getMessages(session.id))).not.toContain("ACTIVITY-CHILD-ONLY")
      const lifecycle = runtimeEvents.flatMap((event) => event.payload.type === "subagent-updated" ? [event.payload] : [])
      expect(lifecycle.map((event) => event.status)).toEqual(["running", "completed"])
      expect(new Set(lifecycle.map((event) => event.subagentKey)).size).toBe(1)
      expect(lifecycle[0]).toMatchObject({ providerId: "activity-child", toolCallId: "activity-spawn", toolCallRole: "spawn", label: "/root/child" })
    } finally {
      await adapter.dispose()
    }
  })

  test("routes Codex child threads through revisioned lifecycle admission into isolated stores", async () => {
    const fake = await makeFakeCodex({ subagent: true })
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const store = createMemoryRuntimeStore()
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      eventHub,
      store,
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")

    const session = await adapter.createSession(fake.dir)
    for await (const _event of executeTestTurn(adapter, session.id, prompt("gpt-5.5"), fake.dir)) {}
    await adapter.dispose()

    const lifecycle = runtimeEvents.filter((event) => event.payload.type === "subagent-updated")
    const childOne = lifecycle.filter((event) => event.payload.type === "subagent-updated" && event.payload.providerId === "thread-child-1")
    const childTwo = lifecycle.filter((event) => event.payload.type === "subagent-updated" && event.payload.providerId === "thread-child-2")
    expect(new Set(childOne.map((event) => event.payload.type === "subagent-updated" ? event.payload.subagentKey : undefined)).size).toBe(1)
    expect(new Set(childTwo.map((event) => event.payload.type === "subagent-updated" ? event.payload.subagentKey : undefined)).size).toBe(1)
    expect(childOne.some((event) => event.payload.type === "subagent-updated" && event.payload.toolCallId === "spawn-1" && event.payload.toolCallRole === "spawn")).toBe(true)
    expect(childTwo.some((event) => event.payload.type === "subagent-updated" && event.payload.toolCallId === "spawn-1" && event.payload.toolCallRole === "spawn")).toBe(true)
    expect(childOne.some((event) => event.payload.type === "subagent-updated" && event.payload.toolCallId === "send-1" && event.payload.toolCallRole === "interaction" && event.payload.status === "completed")).toBe(true)
    expect(childTwo.some((event) => event.payload.type === "subagent-updated" && event.payload.toolCallId === "close-1" && event.payload.toolCallRole === "interaction" && event.payload.status === "killed")).toBe(true)
    expect(childOne.map((event) => event.payload.type === "subagent-updated" ? event.payload.revision : 0)).toEqual(
      childOne.map((_, index) => index + 1),
    )

    const sessions = store.listSessions(fake.dir) as Array<{ id: string; parentID?: string; agent_session_id?: string }>
    const childSessions = sessions.filter((item) => item.parentID === session.id)
    expect(childSessions).toHaveLength(2)
    expect(childSessions.map((item) => item.id)).not.toContain("thread-child-1")
    expect(childSessions.map((item) => item.id)).not.toContain("thread-child-2")
    expect(childSessions.map((item) => item.agent_session_id ?? "").sort((a, b) => a.localeCompare(b)))
      .toEqual(["thread-child-1", "thread-child-2"])
    expect(JSON.stringify(store.getMessages(session.id))).not.toContain("CHILD-ONLY")
    expect(childSessions.some((item) => JSON.stringify(store.getMessages(item.id)).includes("CHILD-ONLY"))).toBe(true)
    expect(childSessions.some((item) => JSON.stringify(store.getMessages(item.id)).includes("SECOND-CHILD-ONLY"))).toBe(true)
    expect(runtimeEvents.filter((event) => event.payload.type === "text-delta").map((event) => event.sessionId)).toEqual(expect.arrayContaining(childSessions.map((item) => item.id)))
  })
})
