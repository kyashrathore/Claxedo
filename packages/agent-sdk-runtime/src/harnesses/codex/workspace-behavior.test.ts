import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { CodexHarnessAdapter } from "./index"
import type { PromptInput } from "../../index"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

class FakeRuntimeStore {
  private sessions = new Map<string, { id: string; directory: string; title?: string }>()
  private configs = new Map<string, Record<string, unknown>>()
  private agentSessionIds = new Map<string, string>()

  constructor(_storeRoot?: string) {}

  bindSession(input: { sessionId: string; directory: string; title?: string; agentSessionId: string }) {
    this.sessions.set(input.sessionId, { id: input.sessionId, directory: input.directory, title: input.title })
    this.agentSessionIds.set(input.sessionId, input.agentSessionId)
  }

  getAgentSessionId(id: string) {
    return this.agentSessionIds.get(id)
  }

  getSession(id: string) {
    return this.sessions.get(id) ?? null
  }

  updateSessionConfig(id: string, patch: Record<string, unknown>) {
    this.configs.set(id, { ...(this.configs.get(id) ?? {}), ...patch })
    return this.configs.get(id)
  }

  getSessionConfig(id: string) {
    return this.configs.get(id)
  }

  startTurn(_input: unknown) {}
  appendEvent(input: { sessionId?: string; payload: unknown }) {
    return {
      sessionId: input.sessionId ?? "session",
      seq: 1,
      createdAt: 1,
      payload: input.payload,
    }
  }
}

async function makeFakeCodex() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-app-server-"))
  tempDirs.push(dir)
  const binary = path.join(dir, "codex")
  const log = path.join(dir, "requests.ndjson")
  await fs.promises.writeFile(binary, `#!/usr/bin/env node
const fs = require("fs")
const logPath = ${JSON.stringify(log)}
let buffer = ""
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}
function append(message) {
  fs.appendFileSync(logPath, JSON.stringify(message) + "\\n")
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
    if (message.method === "initialize") {
      write({ id: message.id, result: { userAgent: "fake-codex" } })
    }
    if (message.method === "thread/start") {
      write({ id: message.id, result: { thread: { id: "thread-1" } } })
      write({ method: "thread/started", params: { thread: { id: "thread-1" } } })
    }
    if (message.method === "turn/start") {
      write({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } })
      write({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } })
      write({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "assistant-1", delta: "OK" } })
      write({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "assistant-1", type: "agentMessage", text: "OK" } } })
      write({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })
    }
  }
})
`, "utf8")
  await fs.promises.chmod(binary, 0o755)
  return { dir, binary, log }
}

function prompt(modelID: string): PromptInput {
  return {
    parts: ["Reply with exactly OK."],
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    agent: "build",
    model: { providerID: "codex-app-server", modelID },
  }
}

async function runWithModels(input: {
  globalModel: string
  promptModel?: string
}) {
  const fake = await makeFakeCodex()
  const adapter = new CodexHarnessAdapter({
    binary: fake.binary,
    createStore: (storeRoot) => new FakeRuntimeStore(storeRoot),
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
})
