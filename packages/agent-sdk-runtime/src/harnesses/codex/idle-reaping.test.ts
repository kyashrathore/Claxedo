import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { CodexHarnessAdapter } from "./index"
import type { PromptInput, SessionConfig } from "../../index"
import type { AgentProcessObserver } from "../../process-observer"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { fakeRuntimeStore } from "../../test-utils/fake-runtime-store"

// The Codex driver used to hold its app-server for the life of the driver, so a
// desktop that ran one turn at breakfast still had `codex app-server` resident
// at midnight. These cases drive the REAL adapter against a stub binary and
// watch the actual child process, because the only thing worth asserting here
// is whether a real process died.

const tempDirs: string[] = []
let previousCodexHome: string | undefined
let previousIdleMs: string | undefined
let codexHomeGuard: string | undefined

beforeAll(() => {
  previousCodexHome = process.env.CODEX_HOME
  previousIdleMs = process.env.CLAXEDO_CODEX_IDLE_TIMEOUT_MS
  codexHomeGuard = fs.mkdtempSync(path.join(os.tmpdir(), "codex-idle-home-"))
  process.env.CODEX_HOME = codexHomeGuard
})

afterAll(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  if (previousIdleMs === undefined) delete process.env.CLAXEDO_CODEX_IDLE_TIMEOUT_MS
  else process.env.CLAXEDO_CODEX_IDLE_TIMEOUT_MS = previousIdleMs
  if (codexHomeGuard) await fs.promises.rm(codexHomeGuard, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

function store(): AgentRuntimeStoreWithRecovery {
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
 * A stub `codex app-server`: enough JSON-RPC to start a thread and complete one
 * turn. `holdMs` delays the turn's completion so a test can prove the idle
 * countdown does not run while a turn is still in flight.
 */
async function fakeCodex(options: { holdMs?: number } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-idle-"))
  tempDirs.push(dir)
  const binary = path.join(dir, "codex")
  await fs.promises.writeFile(binary, `#!/usr/bin/env node
const holdMs = ${JSON.stringify(options.holdMs ?? 0)}
let buffer = ""
function write(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
function completeTurn() {
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
    if (!message.id) continue
    if (message.method === "initialize") write({ id: message.id, result: { userAgent: "fake" } })
    else if (message.method === "thread/start") write({ id: message.id, result: { thread: { id: "thread-1" } } })
    else if (message.method === "turn/start") {
      write({ id: message.id, result: { turn: { id: "turn-1" } } })
      if (holdMs > 0) setTimeout(completeTurn, holdMs)
      else completeTurn()
    }
    else write({ id: message.id, result: {} })
  }
})
`, { mode: 0o755 })
  return { dir, binary }
}

function prompt(): PromptInput {
  return {
    parts: ["Reply with exactly OK."],
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    agent: "build",
    model: { providerID: "codex-app-server", modelID: "default" },
  }
}

/** PIDs the adapter registered, in launch order. */
function pidObserver() {
  const pids: number[] = []
  const observer: AgentProcessObserver = {
    register(descriptor) {
      if (descriptor.harnessId === "codex" && typeof descriptor.pid === "number") pids.push(descriptor.pid)
      return { update: () => undefined, exit: () => undefined }
    },
  }
  return { observer, pids }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

describe("Codex app-server idle reaping", () => {
  test("reaps the app-server after a quiet period and respawns for the next turn", async () => {
    process.env.CLAXEDO_CODEX_IDLE_TIMEOUT_MS = "60"
    const fake = await fakeCodex()
    const { observer, pids } = pidObserver()
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: store,
      storeRoot: path.join(fake.dir, "store"),
      processObserver: observer,
    })

    const session = await adapter.createSession(fake.dir)
    for await (const _event of adapter.sendMessage(session.id, prompt(), fake.dir)) {}

    const first = pids[0]
    expect(typeof first).toBe("number")
    expect(await until(() => !alive(first!), 3_000)).toBe(true)

    // The next turn transparently starts a NEW child rather than failing.
    const second = await adapter.createSession(fake.dir)
    for await (const _event of adapter.sendMessage(second.id, prompt(), fake.dir)) {}
    expect(pids.length).toBeGreaterThan(1)
    expect(pids[1]).not.toBe(first)

    adapter.dispose()
  })

  test("does not reap a turn that is still inside a long silent tool call", async () => {
    // Idle teardown driven by "time since the last request STARTED" would kill
    // this child mid-turn and surface as a hung session. Two things stop it:
    // the turn holds a lease, and the reap refuses while any thread is live —
    // a thread can outlive its turn, so the guard is not redundant with the
    // lease. This asserts the product behaviour both exist for.
    process.env.CLAXEDO_CODEX_IDLE_TIMEOUT_MS = "40"
    const fake = await fakeCodex({ holdMs: 400 })
    const { observer, pids } = pidObserver()
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      createStore: store,
      storeRoot: path.join(fake.dir, "store"),
      processObserver: observer,
    })

    const session = await adapter.createSession(fake.dir)
    const events: unknown[] = []
    for await (const event of adapter.sendMessage(session.id, prompt(), fake.dir)) events.push(event)

    // The turn completed: the child survived a silence far longer than the
    // idle grace because the lease held the countdown open.
    expect(events.length).toBeGreaterThan(0)
    expect(pids).toHaveLength(1)

    adapter.dispose()
  })
})
