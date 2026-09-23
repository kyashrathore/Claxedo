import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { asRecord } from "@claxedo/helpers/guards"
import type { CompatEnvelope } from "../../compat-events"
import type { PromptInput } from "../../index"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"
import { removeTestTempDir } from "../shared/test-temp-dir"
import { CodexHarnessAdapter } from "./index"

const tempDirs: string[] = []
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTestTempDir(dir)
})

type Frame = { method: string; params: Record<string, unknown> }
type Tokens = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }

/**
 * One app-server every session of the adapter shares. `threads` are handed
 * out by `thread/start` in order; each `turn/start` on a thread plays that
 * thread's next scripted turn, and `thread/goal/set` plays the Goal script.
 * A turn whose script does not complete it stays running until another
 * script does.
 */
async function scriptedCodex(script: {
  threads: string[]
  startModels?: Record<string, string>
  turns: Record<string, Frame[][]>
  goal?: { threadId: string; frames: Frame[] }
}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ownership-"))
  tempDirs.push(dir)
  const log = path.join(dir, "requests.ndjson")
  const source = `
const fs = require("fs")
const script = ${JSON.stringify(script)}
const log = ${JSON.stringify(log)}
let buffer = ""
let started = 0
let goal = null
const played = {}
function write(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (true) {
    const boundary = buffer.indexOf("\\n")
    if (boundary < 0) return
    const line = buffer.slice(0, boundary).trim()
    buffer = buffer.slice(boundary + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (!message.id) continue
    fs.appendFileSync(log, JSON.stringify({ method: message.method, threadId: message.params && message.params.threadId }) + "\\n")
    if (message.method === "thread/start") {
      const id = script.threads[started++]
      const model = (script.startModels || {})[id]
      write({ id: message.id, result: { thread: { id }, ...(model ? { model } : {}) } })
    } else if (message.method === "turn/start") {
      const threadId = message.params.threadId
      const turn = played[threadId] || 0
      played[threadId] = turn + 1
      write({ id: message.id, result: { turn: { id: threadId + "-turn-" + (turn + 1), status: "inProgress" } } })
      for (const frame of (script.turns[threadId] || [])[turn] || []) write(frame)
    } else if (message.method === "thread/goal/set") {
      goal = { threadId: message.params.threadId, objective: message.params.objective || (goal && goal.objective), status: message.params.status || "active", createdAt: 1, updatedAt: Date.now() }
      write({ method: "thread/goal/updated", params: { threadId: goal.threadId, turnId: null, goal } })
      write({ id: message.id, result: { goal } })
      if (message.params.objective && script.goal) setTimeout(() => { for (const frame of script.goal.frames) write(frame) }, 0)
    } else if (message.method === "thread/goal/get") {
      write({ id: message.id, result: { goal } })
    } else if (message.method === "thread/goal/clear") {
      goal = null
      write({ id: message.id, result: { cleared: true } })
    } else if (message.method === "thread/backgroundTerminals/list") {
      write({ id: message.id, result: { data: [], nextCursor: null } })
    } else {
      write({ id: message.id, result: {} })
    }
  }
})
`
  if (process.platform !== "win32") {
    const binary = path.join(dir, "codex")
    await fs.promises.writeFile(binary, `#!/usr/bin/env node\n${source}`, "utf8")
    await fs.promises.chmod(binary, 0o755)
    return { dir, binary, log }
  }
  const implementation = path.join(dir, "codex-impl.cjs")
  await fs.promises.writeFile(implementation, source, "utf8")
  const binary = path.join(dir, "codex.cmd")
  await fs.promises.writeFile(binary, `@echo off\r\nnode "%~dp0codex-impl.cjs" %*\r\n`, "utf8")
  return { dir, binary, log }
}

async function waitFor(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return
    await Bun.sleep(5)
  }
  throw new Error("condition never held")
}

function requested(log: string, method: string, threadId: string) {
  return fs.promises.readFile(log, "utf8").then(
    (rows) => rows.trim().split("\n").filter(Boolean).some((row) => {
      const request = JSON.parse(row) as { method: string; threadId?: string }
      return request.method === method && request.threadId === threadId
    }),
    () => false,
  )
}

const frame = {
  turnStarted: (threadId: string, turnId: string): Frame => ({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } }),
  turnCompleted: (threadId: string, turnId: string): Frame => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }),
  started: (id: string, parentThreadId: string): Frame => ({ method: "thread/started", params: { thread: { id, parentThreadId, status: { type: "active", activeFlags: [] } } } }),
  reply: (threadId: string, turnId: string, text: string): Frame => ({ method: "item/completed", params: { threadId, turnId, item: { id: `${threadId}-reply`, type: "agentMessage", text } } }),
  usage: (threadId: string, turnId: string, total: Tokens, last: Tokens = total): Frame => ({
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: { total, last, modelContextWindow: 258400 } },
  }),
  rerouted: (threadId: string, turnId: string, toModel: string): Frame => ({
    method: "model/rerouted",
    params: { threadId, turnId, fromModel: "unused", toModel, reason: "highRiskCyberActivity" },
  }),
}

function tokens(inputTokens: number, outputTokens = 0): Tokens {
  return { inputTokens, cachedInputTokens: 0, outputTokens, reasoningOutputTokens: 0 }
}

function prompt(id: string, modelID = "gpt-5.5"): PromptInput {
  return {
    parts: [{ type: "text", text: "work" }],
    userMessageId: `user-${id}`,
    assistantMessageId: `assistant-${id}`,
    agent: "build",
    model: { providerID: "codex", modelID },
  }
}

/** An adapter over one app-server, and every usage fact it writes and publishes. */
async function harness(script: Parameters<typeof scriptedCodex>[0]) {
  const fake = await scriptedCodex(script)
  const store = createMemoryRuntimeStore()
  const eventHub = createRuntimeEventHub()
  const written: Array<{ sessionId: string; payload: CompatEnvelope["payload"] }> = []
  const append = store.appendEvent.bind(store)
  store.appendEvent = (input) => {
    written.push({ sessionId: input.sessionId, payload: input.payload })
    return append(input)
  }
  const published: CompatEnvelope["payload"][] = []
  eventHub.subscribeGlobal((event) => published.push(event.payload))
  const adapter = new CodexHarnessAdapter({ binary: fake.binary, eventHub, store, storeRoot: path.join(fake.dir, "store") })
  adapter.setModel("gpt-5.5")
  const usage = (events: CompatEnvelope["payload"][]) => events.flatMap((payload) => {
    if (payload.type !== "session.usage" || !payload.properties.observation) return []
    const observation = payload.properties.observation
    return [{
      sessionId: payload.properties.sessionID,
      messageId: payload.properties.messageID,
      kind: observation.kind,
      scope: asRecord(observation)?.scope,
      thread: observation.nativeSessionId,
      input: observation.tokens.input,
      ...(observation.model ? { model: observation.model } : {}),
    }]
  })
  const run = async (sessionId: string, input: PromptInput) => {
    for await (const _event of executeTestTurn(adapter, sessionId, input, fake.dir)) {}
  }
  return {
    fake,
    adapter,
    store,
    run,
    /** What the store holds for `sessionId`. */
    metered: (sessionId: string) => usage(written.filter((row) => row.sessionId === sessionId).map((row) => row.payload)),
    /** What reached the hub the meters read. */
    published: () => usage(published),
    written: (sessionId: string) => written.filter((row) => row.sessionId === sessionId).map((row) => row.payload),
    children: (sessionId: string) => (store.listSessions(fake.dir) as Array<{ id: string; parentID?: string }>)
      .filter((row) => row.parentID === sessionId)
      .map((row) => row.id),
  }
}

test("a title thread running during another session's turn is billed to the session that asked for the title only", async () => {
  const h = await harness({
    threads: ["thread-A", "thread-B", "thread-title"],
    startModels: { "thread-title": "gpt-5.4-mini" },
    turns: {
      "thread-A": [[
        frame.turnStarted("thread-A", "a-1"),
        frame.usage("thread-A", "a-1", tokens(100, 10)),
        frame.reply("thread-A", "a-1", "done"),
        frame.turnCompleted("thread-A", "a-1"),
      ]],
      "thread-B": [[frame.turnStarted("thread-B", "b-1")]],
      "thread-title": [[
        frame.turnStarted("thread-title", "title-1"),
        frame.usage("thread-title", "title-1", tokens(30, 5)),
        frame.reply("thread-title", "title-1", JSON.stringify({ title: "Named" })),
        frame.turnCompleted("thread-title", "title-1"),
        frame.usage("thread-B", "b-1", tokens(50, 4)),
        frame.turnCompleted("thread-B", "b-1"),
      ]],
    },
  })
  try {
    const a = await h.adapter.createSession(h.fake.dir)
    const b = await h.adapter.createSession(h.fake.dir)
    await h.run(a.id, prompt("A"))
    const turnB = h.run(b.id, prompt("B"))
    await waitFor(() => requested(h.fake.log, "turn/start", "thread-B"))

    const title = await h.adapter.generateTitle(executionBinding(a.id, h.fake.dir), {
      directory: h.fake.dir,
      system: "Name it",
      user: "User: work",
      signal: new AbortController().signal,
    })
    await turnB

    expect(title).toBe("Named")
    expect(h.metered(b.id)).toEqual([
      { sessionId: b.id, messageId: "assistant-B", kind: "cumulative", scope: "thread-B:b-1", thread: "thread-B", input: 50, model: "gpt-5.5" },
    ])
    const titleUsage = {
      sessionId: a.id,
      messageId: "assistant-A",
      kind: "delta" as const,
      scope: "title:thread-title",
      thread: "thread-title",
      input: 30,
      model: "gpt-5.4-mini",
    }
    expect(h.metered(a.id)).toEqual([
      { sessionId: a.id, messageId: "assistant-A", kind: "cumulative", scope: "thread-A:a-1", thread: "thread-A", input: 100, model: "gpt-5.5" },
      titleUsage,
    ])
    expect(h.published().filter((row) => row.thread === "thread-title")).toEqual([titleUsage])
  } finally {
    await h.adapter.dispose()
  }
})

test("a Goal turn's subagent is counted once, on its own child, while another session's turn runs", async () => {
  const h = await harness({
    threads: ["thread-P", "thread-G"],
    turns: { "thread-P": [[frame.turnStarted("thread-P", "p-1")]] },
    goal: {
      threadId: "thread-G",
      frames: [
        frame.turnStarted("thread-G", "g-1"),
        frame.started("goal-child", "thread-G"),
        frame.usage("goal-child", "gc-1", tokens(70, 7)),
        frame.turnCompleted("goal-child", "gc-1"),
        frame.usage("thread-G", "g-1", tokens(20, 2)),
        frame.reply("thread-G", "g-1", "goal step"),
        frame.turnCompleted("thread-G", "g-1"),
        frame.usage("thread-P", "p-1", tokens(40, 4)),
        frame.turnCompleted("thread-P", "p-1"),
      ],
    },
  })
  try {
    const p = await h.adapter.createSession(h.fake.dir)
    const g = await h.adapter.createSession(h.fake.dir)
    const turnP = h.run(p.id, prompt("P"))
    await waitFor(() => requested(h.fake.log, "turn/start", "thread-P"))

    expect(await h.adapter.goals!.start(g.id, { objective: "Ship" }, h.fake.dir)).toMatchObject({ ok: true })
    await turnP
    await waitFor(() => h.published().some((row) => row.thread === "thread-G"))

    expect(h.metered(p.id)).toEqual([
      { sessionId: p.id, messageId: "assistant-P", kind: "cumulative", scope: "thread-P:p-1", thread: "thread-P", input: 40, model: "gpt-5.5" },
    ])
    const [child] = h.children(g.id)
    expect(child).toBeDefined()
    const everywhere = h.published().filter((row) => row.thread === "goal-child")
    expect(everywhere).toEqual([
      expect.objectContaining({ sessionId: child, kind: "cumulative", scope: "goal-child:gc-1", input: 70 }),
    ])
  } finally {
    await h.adapter.dispose()
  }
})

test("a subagent still spending after its turn ended stays its own session's, not the next running turn's", async () => {
  const h = await harness({
    threads: ["thread-A", "thread-B"],
    turns: {
      "thread-A": [[
        frame.turnStarted("thread-A", "a-1"),
        frame.started("child-A", "thread-A"),
        frame.usage("child-A", "ca-1", tokens(100, 10)),
        frame.usage("thread-A", "a-1", tokens(10, 1)),
        frame.turnCompleted("thread-A", "a-1"),
      ]],
      "thread-B": [[
        frame.turnStarted("thread-B", "b-1"),
        frame.usage("child-A", "ca-1", tokens(160, 16), tokens(60, 6)),
        frame.usage("thread-B", "b-1", tokens(30, 3)),
        frame.turnCompleted("thread-B", "b-1"),
      ]],
    },
  })
  try {
    const a = await h.adapter.createSession(h.fake.dir)
    const b = await h.adapter.createSession(h.fake.dir)
    await h.run(a.id, prompt("A"))
    await h.run(b.id, prompt("B"))

    expect(h.metered(b.id)).toEqual([
      { sessionId: b.id, messageId: "assistant-B", kind: "cumulative", scope: "thread-B:b-1", thread: "thread-B", input: 30, model: "gpt-5.5" },
    ])
    const [child] = h.children(a.id)
    expect(h.metered(child)).toEqual([
      expect.objectContaining({ kind: "cumulative", scope: "child-A:ca-1", thread: "child-A", input: 100 }),
    ])
    expect(h.metered(a.id)).toEqual([
      { sessionId: a.id, messageId: "assistant-A", kind: "cumulative", scope: "thread-A:a-1", thread: "thread-A", input: 10, model: "gpt-5.5" },
      { sessionId: a.id, messageId: "assistant-A", kind: "delta", scope: "detached:child-A", thread: "child-A", input: 60 },
    ])
    expect(h.published().filter((row) => row.thread === "child-A").map((row) => row.input)).toEqual([100, 60])
  } finally {
    await h.adapter.dispose()
  }
})

test("each Codex observation names the model the app-server reported serving it", async () => {
  const h = await harness({
    threads: ["thread-A"],
    startModels: { "thread-A": "gpt-5.5-2026-09" },
    turns: {
      "thread-A": [[
        frame.turnStarted("thread-A", "a-1"),
        frame.usage("thread-A", "a-1", tokens(100, 10)),
        frame.rerouted("thread-A", "a-1", "gpt-5.4-safe"),
        frame.usage("thread-A", "a-1", tokens(160, 16), tokens(60, 6)),
        frame.turnCompleted("thread-A", "a-1"),
      ]],
    },
  })
  try {
    const a = await h.adapter.createSession(h.fake.dir)
    await h.run(a.id, prompt("A", "default"))

    expect(h.metered(a.id)).toEqual([
      { sessionId: a.id, messageId: "assistant-A", kind: "cumulative", scope: "thread-A:a-1", thread: "thread-A", input: 100, model: "gpt-5.5-2026-09" },
      { sessionId: a.id, messageId: "assistant-A", kind: "cumulative", scope: "thread-A:a-1@gpt-5.4-safe", thread: "thread-A", input: 60, model: "gpt-5.4-safe" },
    ])
  } finally {
    await h.adapter.dispose()
  }
})

test("a nested subagent's error reaches its first-level ancestor's session as a diagnostic, not its terminal", async () => {
  const h = await harness({
    threads: ["thread-A"],
    turns: {
      "thread-A": [[
        frame.turnStarted("thread-A", "a-1"),
        frame.started("child-A", "thread-A"),
        frame.started("grandchild-A", "child-A"),
        { method: "error", params: { threadId: "grandchild-A", turnId: "g-1", willRetry: false, error: { message: "grandchild broke" } } },
        frame.turnCompleted("thread-A", "a-1"),
      ]],
    },
  })
  try {
    const a = await h.adapter.createSession(h.fake.dir)
    await h.run(a.id, prompt("A"))

    const [child] = h.children(a.id)
    const diagnostics = h.written(child).flatMap((payload) => payload.type === "runtime.diagnostic" ? [payload.properties] : [])
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "codex_app_server.descendant_error", message: "grandchild broke", severity: "warn" }))
    expect(h.written(child).some((payload) => payload.type === "session.error")).toBe(false)
  } finally {
    await h.adapter.dispose()
  }
})

