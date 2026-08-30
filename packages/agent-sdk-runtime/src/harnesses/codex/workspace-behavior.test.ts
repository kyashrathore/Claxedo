import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
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
import { storeRows } from "../../test-utils/store-internals"

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
      const next = { ...(configs.get(id) ?? {}), ...update } as SessionConfig
      configs.set(id, next)
      return next
    },
    getSessionConfig: (id) => configs.get(id),
  })
}

/**
 * Windows cannot execute a shebang script, so there the fake is a .cmd shim
 * delegating to node — the same launcher shape a real npm install of codex
 * puts on PATH, which the driver routes through the shell.
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
  requestRefresh?: boolean
  auth401?: boolean
  models?: unknown[]
  subagent?: boolean
  initializeDelayMs?: number
  loginDelayMs?: number
  ignoreSigterm?: boolean
} = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-app-server-"))
  tempDirs.push(dir)
  const log = path.join(dir, "requests.ndjson")
  const binary = await installFakeBinary(dir, `
const fs = require("fs")
const logPath = ${JSON.stringify(log)}
const requestRefresh = ${JSON.stringify(options.requestRefresh === true)}
const auth401 = ${JSON.stringify(options.auth401 === true)}
const subagent = ${JSON.stringify(options.subagent === true)}
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
append({ event: "started", pid: process.pid })
process.on("SIGTERM", () => {
  append({ event: "sigterm" })
  if (ignoreSigterm) return
  process.exit(0)
})
function completeTurn() {
  if (completed) return
  completed = true
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
    if (message.id === 900 && message.result) completeTurn()
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
    if (message.method === "turn/start") {
      if (auth401) {
        process.stderr.write("failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses\\n")
        return
      }
      write({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } })
      write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } })
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
    parts: ["Reply with exactly OK."],
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
  for await (const _event of adapter.sendMessage(session.id, prompt(input.promptModel ?? input.globalModel), fake.dir)) {}
  adapter.dispose()
  return fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    method: string
    params?: Record<string, unknown>
  })
}

async function runWithModel(model: string) {
  return runWithModels({ globalModel: model })
}

describe("CodexHarnessAdapter", () => {
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
    adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method: string
    })
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1)
  })

  test("applies auth changed during startup before creating the Codex thread", async () => {
    const fake = await makeFakeCodex({ initializeDelayMs: 50 })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })

    const creation = adapter.createSession(fake.dir)
    await waitForLog(fake.log, (row) => row.method === "initialize")
    await Promise.all([
      creation,
      adapter.applyConfig({ auth: { "codex-app-server": "sk-during-startup" } }),
    ])
    adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method?: string
      params?: Record<string, unknown>
    })
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1)
    expect(requests.find((request) => request.method === "account/login/start")?.params).toEqual({
      type: "apiKey",
      apiKey: "sk-during-startup",
    })
    expect(requests.findIndex((request) => request.method === "account/login/start"))
      .toBeLessThan(requests.findIndex((request) => request.method === "thread/start"))
  })

  test("applies changed auth to the retained Codex app-server", async () => {
    const fake = await makeFakeCodex({ loginDelayMs: 50 })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: () => fakeCodexStore(),
      storeRoot: path.join(fake.dir, "store"),
    })

    await adapter.createSession(fake.dir)
    let applied = false
    const config = adapter.applyConfig({ auth: { "codex-app-server": "sk-live" } }).then(() => {
      applied = true
    })
    await waitForLog(fake.log, (row) => row.method === "account/login/start")
    expect(applied).toBe(false)
    await config
    await adapter.createSession(fake.dir)
    adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method?: string
      params?: Record<string, unknown>
    })
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1)
    expect(requests.find((request) => request.method === "account/login/start")?.params).toEqual({
      type: "apiKey",
      apiKey: "sk-live",
    })
    expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(2)
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
    adapter.dispose()

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
    adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method?: string
      params?: Record<string, unknown>
    })
    expect(requests.find((request) => request.method === "thread/start")?.params?.developerInstructions).toBe(transcript)
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

    expect(await adapter.probeConfigOptions(fake.dir)).toContainEqual({
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
    adapter.dispose()
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
    for await (const _event of adapter.sendMessage(session.id, prompt("gpt-5.5", "minimal"), fake.dir)) {}
    adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      method: string
      params?: Record<string, unknown>
    })
    expect(requests.find((request) => request.method === "turn/start")!.params?.effort).toBe("minimal")
  })

  test("logs into Codex app-server with ChatGPT tokens and answers refresh requests", async () => {
    const fake = await makeFakeCodex({ requestRefresh: true })
    const refreshBodies: string[] = []
    const codexHome = path.join(fake.dir, "codex-home")
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      // Isolate refresh writes from the developer's Codex home.
      codexHome,
      fetch: async (_url, init) => {
        refreshBodies.push(String(init?.body))
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
    await adapter.applyConfig({
      auth: {
        "codex-app-server": JSON.stringify({
          type: "codex_auth",
          auth_mode: "chatgpt",
          OPENAI_API_KEY: "sk-should-not-be-used",
          tokens: {
            access_token: "stale-access-token",
            refresh_token: "stale-refresh-token",
            account_id: "acct-1",
          },
        }),
      },
    })

    const session = await adapter.createSession(fake.dir)
    for await (const _event of adapter.sendMessage(session.id, prompt("gpt-5.5"), fake.dir)) {}
    adapter.dispose()

    const requests = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: Record<string, unknown>
    })
    expect(requests.find((request) => request.method === "account/login/start")?.params).toMatchObject({
      type: "chatgptAuthTokens",
      accessToken: "stale-access-token",
      chatgptAccountId: "acct-1",
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
    for await (const event of adapter.sendMessage(session.id, prompt("gpt-5.5"), fake.dir)) events.push(event)
    adapter.dispose()

    expect(events.some((event) => JSON.stringify(event).includes("Codex authentication failed with 401 Unauthorized"))).toBe(true)
  })

  test("routes Codex child threads through revisioned lifecycle admission into isolated stores", async () => {
    const fake = await makeFakeCodex({ subagent: true })
    const eventHub = createRuntimeEventHub()
    const runtimeEvents: RuntimeEventEnvelope[] = []
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const store = storeRows(createMemoryRuntimeStore())
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      eventHub,
      store,
      storeRoot: path.join(fake.dir, "store"),
    })
    adapter.setModel("gpt-5.5")

    const session = await adapter.createSession(fake.dir)
    for await (const _event of adapter.sendMessage(session.id, prompt("gpt-5.5"), fake.dir)) {}
    adapter.dispose()

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
    expect(childSessions.map((item) => item.agent_session_id).sort()).toEqual(["thread-child-1", "thread-child-2"])
    expect(JSON.stringify(store.getMessages(session.id))).not.toContain("CHILD-ONLY")
    expect(childSessions.some((item) => JSON.stringify(store.getMessages(item.id)).includes("CHILD-ONLY"))).toBe(true)
    expect(childSessions.some((item) => JSON.stringify(store.getMessages(item.id)).includes("SECOND-CHILD-ONLY"))).toBe(true)
    expect(runtimeEvents.filter((event) => event.payload.type === "text-delta").map((event) => event.sessionId)).toEqual(expect.arrayContaining(childSessions.map((item) => item.id)))
  })
})
