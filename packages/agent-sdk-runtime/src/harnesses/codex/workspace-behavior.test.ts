import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { CodexHarnessAdapter } from "./index"
import type { PromptInput, SessionConfig } from "../../index"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { fakeRuntimeStore } from "../../test-utils/fake-runtime-store"

const tempDirs: string[] = []

// Global safety net: force every codex test onto a throwaway CODEX_HOME so a
// refresh can never rewrite the developer's real ~/.codex/auth.json. A missing
// guard here previously clobbered live credentials with mock tokens.
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

/**
 * Session/config state the codex adapter actually round-trips, layered on the
 * shared inert base so the double stays a complete runtime store. (As a
 * hand-rolled class it implemented 7 of the port's members and the gap went
 * unnoticed while tests were outside the typecheck.)
 */
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

async function makeFakeCodex(options: { requestRefresh?: boolean; auth401?: boolean; models?: unknown[] } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-app-server-"))
  tempDirs.push(dir)
  const binary = path.join(dir, "codex")
  const log = path.join(dir, "requests.ndjson")
  await fs.promises.writeFile(binary, `#!/usr/bin/env node
const fs = require("fs")
const logPath = ${JSON.stringify(log)}
const requestRefresh = ${JSON.stringify(options.requestRefresh === true)}
const auth401 = ${JSON.stringify(options.auth401 === true)}
const models = ${JSON.stringify(options.models ?? [])}
let buffer = ""
let completed = false
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}
function append(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\\n")
}
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
      write({ id: message.id, result: { userAgent: "fake-codex" } })
    }
    if (message.method === "account/login/start") {
      write({ id: message.id, result: { type: "chatgptAuthTokens" } })
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
      if (requestRefresh) {
        write({ id: 900, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "acct-1" } })
      } else {
        completeTurn()
      }
    }
  }
})
`, "utf8")
  await fs.promises.chmod(binary, 0o755)
  return { dir, binary, log }
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
      // Isolate the codex home so the refresh never rewrites the developer's real
      // ~/.codex/auth.json (which previously clobbered live credentials on test runs).
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
})
