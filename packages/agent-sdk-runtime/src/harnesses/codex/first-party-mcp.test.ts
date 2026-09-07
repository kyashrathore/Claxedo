import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { FIRST_PARTY_MCP_CONFIG_KEY } from "../../first-party-mcp"
import { createCodexAppServerDriver } from "./driver"

const TOKEN = "first-party-codex-secret"
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTestTempDir(dir)
})

/**
 * A stdio app-server that answers the driver's startup handshake and records
 * every `thread/start` request it receives; on Windows the launcher is the
 * `.cmd` shim shape a real npm install of codex puts on PATH.
 */
async function fakeAppServer() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-first-party-"))
  tempDirs.push(dir)
  const log = path.join(dir, "requests.ndjson")
  const script = `
const fs = require("fs")
const logPath = ${JSON.stringify(log)}
let buffer = ""
let turns = 0
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
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
    if (message.method === "initialize") write({ id: message.id, result: { userAgent: "fake-codex" } })
    if (message.method === "account/login/start") write({ id: message.id, result: { type: "apiKey" } })
    if (message.method === "account/logout") write({ id: message.id, result: {} })
    if (message.method === "thread/start") {
      fs.appendFileSync(logPath, JSON.stringify(message) + "\\n")
      write({ id: message.id, result: { thread: { id: "thread-" + message.id } } })
    }
    if (message.method === "thread/resume") {
      fs.appendFileSync(logPath, JSON.stringify(message) + "\\n")
      write({ id: message.id, result: { thread: { id: message.params.threadId } } })
    }
    if (message.method === "turn/start") {
      turns += 1
      if (turns === 1) {
        write({ id: message.id, error: { message: "thread not found: " + message.params.threadId } })
        continue
      }
      write({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } })
      write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "inProgress" } } })
      write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "completed" } } })
    }
  }
})
`
  let binary: string
  if (process.platform === "win32") {
    await fs.promises.writeFile(path.join(dir, "codex-impl.cjs"), script, "utf8")
    binary = path.join(dir, "codex.cmd")
    await fs.promises.writeFile(binary, `@echo off\r\nnode "%~dp0codex-impl.cjs" %*\r\n`, "utf8")
  } else {
    binary = path.join(dir, "codex")
    await fs.promises.writeFile(binary, `#!/usr/bin/env node\n${script}`, "utf8")
    await fs.promises.chmod(binary, 0o755)
  }
  const codexHome = path.join(dir, "home")
  await fs.promises.mkdir(codexHome, { recursive: true })
  const requests = async () => (await fs.promises.readFile(log, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { params: Record<string, unknown> })
  return { binary, codexHome, dir, requests }
}

function driverFor(binary: string, codexHome: string) {
  return createCodexAppServerDriver({
    lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }) as never,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
    getAgentSessionId: () => null,
    getSessionForAgentSession: () => null,
    getGoal: () => null,
    getSessionConfig: () => null,
    publishGoal() {},
    async runProviderTurn() { return true },
  }, { binary, codexHome })
}

describe("Codex first-party MCP injection", () => {
  test("starts each thread with a per-session claxedo server in the request config and leaves CODEX_HOME untouched", async () => {
    const fake = await fakeAppServer()
    const driver = driverFor(fake.binary, fake.codexHome)
    try {
      await driver.applyConfig({
        mcp: {},
        [FIRST_PARTY_MCP_CONFIG_KEY]: {
          server: (sessionId: string) => ({
            name: "claxedo",
            url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
            headers: { Authorization: `Bearer ${TOKEN}` },
          }),
        },
      })
      await driver.createAgentSession({ directory: fake.dir, model: "gpt-5-codex", sessionId: "session-a" })
      await driver.createAgentSession({ directory: fake.dir, model: "gpt-5-codex", sessionId: "session-b" })

      const starts = await fake.requests()
      expect(starts.map((row) => row.params.config)).toEqual([
        { mcp_servers: { claxedo: { url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-a", http_headers: { Authorization: `Bearer ${TOKEN}` } } } },
        { mcp_servers: { claxedo: { url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-b", http_headers: { Authorization: `Bearer ${TOKEN}` } } } },
      ])
      expect(await fs.promises.readdir(fake.codexHome)).toEqual([])
    } finally {
      await driver.dispose?.()
    }
  })

  test("a thread the app-server lost is resumed with the same per-session entry, so a restart keeps the tools", async () => {
    const fake = await fakeAppServer()
    const driver = driverFor(fake.binary, fake.codexHome)
    try {
      await driver.applyConfig({
        mcp: {},
        [FIRST_PARTY_MCP_CONFIG_KEY]: {
          server: (sessionId: string) => ({
            name: "claxedo",
            url: `http://127.0.0.1:2593/api/claxedo/mcp?session=${sessionId}`,
            headers: { Authorization: `Bearer ${TOKEN}` },
          }),
        },
      })
      const { id: threadId } = await driver.createAgentSession({ directory: fake.dir, model: "gpt-5-codex", sessionId: "session-a" })
      await driver.runTurn({
        sessionId: "session-a",
        getAgentSessionId: () => threadId,
        input: {
          parts: [{ type: "text", text: "Reply with exactly OK." }],
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          agent: "build",
          model: { providerID: "codex-app-server", modelID: "default" },
        },
        directory: fake.dir,
        abort: new AbortController(),
        ingest() {},
        associateChild() {},
        observeSubagent: async () => ({ event: {} as never }),
        rebindAgentSession() {},
        model: "default",
      })

      const resumes = (await fake.requests()).filter((row) => "threadId" in row.params)
      expect(resumes).toHaveLength(1)
      expect(resumes[0]?.params).toMatchObject({
        threadId,
        config: { mcp_servers: { claxedo: { url: "http://127.0.0.1:2593/api/claxedo/mcp?session=session-a", http_headers: { Authorization: `Bearer ${TOKEN}` } } } },
      })
    } finally {
      await driver.dispose?.()
    }
  })

  test("starts a thread with no config override when the runtime supplies no provider", async () => {
    const fake = await fakeAppServer()
    const driver = driverFor(fake.binary, fake.codexHome)
    try {
      await driver.applyConfig({ mcp: {} })
      await driver.createAgentSession({ directory: fake.dir, model: "gpt-5-codex", sessionId: "session-a" })
      expect((await fake.requests()).map((row) => "config" in row.params)).toEqual([false])
    } finally {
      await driver.dispose?.()
    }
  })
})
