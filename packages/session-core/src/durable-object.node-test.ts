import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { builtinModules } from "node:module"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { build, type Plugin } from "esbuild"
import { Miniflare } from "miniflare"

const FIXTURE = fileURLToPath(new URL("./test-support/durable-object-host.ts", import.meta.url))
const PACKAGES = path.resolve(import.meta.dirname, "../..")
const DIRECTORY = "/workspace"
const WORKSPACE_HEADER = "x-workspace-id"

const reached = new Set<string>()
const nodeImports: Plugin = {
  name: "node-imports",
  setup(build) {
    build.onResolve({ filter: new RegExp(`^(node:|(${builtinModules.join("|")})(/|$))`) }, (args) => {
      reached.add(`${args.path} <- ${path.relative(PACKAGES, args.importer).split(path.sep).join("/")}`)
      return { path: args.path, external: true }
    })
  },
}

async function bundle() {
  const result = await build({
    entryPoints: [FIXTURE],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["development"],
    target: "es2022",
    write: false,
    plugins: [nodeImports],
  })
  return result.outputFiles[0]!.text
}

/** A workerd process over the bundle, with what its objects wrote to stderr. */
function launchWorkerd(script: string, persist: string | false) {
  const stderr: string[] = []
  const miniflare = new Miniflare({
    compatibilityDate: "2026-07-22",
    modules: [{ type: "ESModule", path: "index.mjs", contents: script }],
    durableObjects: { SESSION_CORE: { className: "SessionCoreObject", useSQLite: true } },
    durableObjectsPersist: persist,
    handleRuntimeStdio: (stdout: Readable, err: Readable) => {
      stdout.resume()
      err.on("data", (chunk: Buffer) => stderr.push(chunk.toString()))
    },
  })
  return Object.assign(miniflare, { stderr: () => stderr.join("") })
}

type Workerd = ReturnType<typeof launchWorkerd>

type Frame = { directory?: string; payload?: { type: string; properties?: Record<string, any> } }

type StoredMessage = {
  info: { id: string; role: string }
  parts: Array<{ type: string; text?: string; callID?: string; state?: { status: string; error?: string } }>
}

const RESTART_MESSAGE = "ACP process restarted; pending interactive state must be rerun"

/** One workspace's Durable Object, reached the way a client reaches a runtime: over its HTTP routes. */
function workspace(miniflare: Miniflare, workspaceId: string) {
  const url = (route: string) => `http://session-core${route}`
  const headers = { [WORKSPACE_HEADER]: workspaceId }

  async function json<T>(route: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const response = await miniflare.dispatchFetch(url(route), {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    assert.ok(response.ok, `${workspaceId} ${init?.method ?? "GET"} ${route} answered ${response.status}: ${text}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  /** Opens the workspace event stream; frames accumulate until `close`. */
  async function stream() {
    const controller = new AbortController()
    const response = await miniflare.dispatchFetch(url(`/api/wr/events?directory=${encodeURIComponent(DIRECTORY)}`), {
      headers,
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const frames: Frame[] = []
    let buffered = ""
    const read = async () => {
      const next = await reader.read()
      if (next.done) return false
      buffered += decoder.decode(next.value, { stream: true })
      const blocks = buffered.split("\n\n")
      buffered = blocks.pop() ?? ""
      for (const block of blocks) {
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n")
        if (data) frames.push(JSON.parse(data) as Frame)
      }
      return true
    }
    let reading: Promise<boolean> | undefined
    /** The next chunk, or `undefined` once `at` passes; a read cut short stays pending for the next call. */
    const readBefore = async (at: number) => {
      reading ??= read()
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, at - Date.now())) })
      const next = await Promise.race([reading, expired]).finally(() => clearTimeout(timer))
      if (next !== undefined) reading = undefined
      return next
    }
    return {
      frames,
      async until(done: (frames: Frame[]) => boolean, what: string, withinMs = 5_000) {
        const at = Date.now() + withinMs
        while (!done(frames)) {
          const next = await readBefore(at)
          if (next === undefined) throw new Error(`${workspaceId}: ${what} did not happen within ${withinMs} ms; frames: ${frames.map((frame) => frame.payload?.type ?? "heartbeat").join(", ")}`)
          if (!next) throw new Error(`${workspaceId}'s stream ended before ${what}`)
        }
      },
      /** Collects whatever arrives for `ms`. */
      async drain(ms: number) {
        const at = Date.now() + ms
        while (await readBefore(at) !== undefined);
      },
      async close() {
        controller.abort()
        await reader.cancel().catch(() => {})
      },
    }
  }

  return {
    json,
    stream,
    create: () => json<{ id: string }>(`/session?directory=${encodeURIComponent(DIRECTORY)}`, { method: "POST", body: {} }),
    prompt: (sessionId: string, text: string, delivery?: "queue") =>
      json(`/session/${sessionId}/prompt_async`, { method: "POST", body: { parts: [{ type: "text", text }], ...(delivery ? { delivery } : {}) } }),
    messages: (sessionId: string) => json<StoredMessage[]>(`/session/${sessionId}/message`),
    queue: (sessionId: string) => json<Array<{ seq: number }>>(`/session/${sessionId}/queue`),
    status: () => json<Record<string, { type: string; message?: string }>>(`/session/status?directory=${encodeURIComponent(DIRECTORY)}`),
  }
}

/**
 * Polls the routes until `check` holds. A re-issued turn starts as the object
 * boots, before the request that woke it can subscribe to the stream, so the
 * store is the only place that turn can be observed.
 */
async function eventually(check: () => Promise<boolean>, what: string, withinMs = 5_000) {
  const at = Date.now() + withinMs
  while (!await check()) {
    if (Date.now() > at) throw new Error(`${what} did not happen within ${withinMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const heldToolRunning = (sessionId: string) => (frames: Frame[]) =>
  frames.some((frame) => frame.payload?.type === "message.part.updated" && frame.payload.properties?.sessionID === sessionId
    && frame.payload.properties.part?.callID === "call_held")

const idleFor = (sessionId: string) => (frames: Frame[]) =>
  frames.some((frame) => frame.payload?.type === "session.idle" && frame.payload.properties?.sessionID === sessionId)

/** Each text part as the stream carried it: its snapshot, then the deltas appended to it. */
function streamedText(frames: Frame[], sessionId: string) {
  const parts = new Map<string, string>()
  for (const { payload } of frames) {
    const properties = payload?.properties
    if (!payload || properties?.sessionID !== sessionId) continue
    if (payload.type === "message.part.updated" && properties.part.type === "text") parts.set(properties.part.id, properties.part.text ?? "")
    if (payload.type === "message.part.delta" && properties.field === "text") parts.set(properties.partID, (parts.get(properties.partID) ?? "") + properties.delta)
  }
  return [...parts.values()]
}

function transcript(messages: StoredMessage[]) {
  return messages.map((message) => ({
    role: message.info.role,
    text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
  }))
}

void describe("the session core in a Durable Object under workerd", () => {
  let script: string
  const roots: string[] = []
  const running: Workerd[] = []
  const start = (persist: string | false) => {
    const miniflare = launchWorkerd(script, persist)
    running.push(miniflare)
    return miniflare
  }

  before(async () => {
    script = await bundle()
  })

  after(async () => {
    for (const miniflare of running) await miniflare.dispose().catch(() => {})
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  })

  void it("bundles no Node builtin, so the worker runs without nodejs_compat", () => {
    assert.deepEqual([...reached].sort(), [])
  })

  void it("creates a session, streams its turn, reads the transcript back, and keeps both across a restart", async () => {
    const persist = fs.mkdtempSync(path.join(os.tmpdir(), "wr-session-core-do-"))
    roots.push(persist)
    const first = start(persist)
    const client = workspace(first, "ws_restart")
    const session = await client.create()
    assert.match(session.id, /^ses_/)

    const events = await client.stream()
    await client.prompt(session.id, "hello")
    await events.until(idleFor(session.id), "the turn to go idle")
    await events.close()
    assert.deepEqual(streamedText(events.frames, session.id), ["hello", "echo: hello"])

    const stored = await client.messages(session.id)
    assert.deepEqual(transcript(stored), [{ role: "user", text: "hello" }, { role: "assistant", text: "echo: hello" }])

    await first.dispose()
    const restarted = workspace(start(persist), "ws_restart")

    assert.equal((await restarted.json<{ id: string }>(`/session/${session.id}`)).id, session.id)
    assert.deepEqual(await restarted.messages(session.id), stored)

    const resumed = await restarted.stream()
    await restarted.prompt(session.id, "again")
    await resumed.until(idleFor(session.id), "the resumed turn to go idle")
    await resumed.close()
    assert.deepEqual(transcript(await restarted.messages(session.id)), [
      { role: "user", text: "hello" },
      { role: "assistant", text: "echo: hello" },
      { role: "user", text: "again" },
      { role: "assistant", text: "echo: again" },
    ])
  })

  void it("streams one workspace's object nothing of another's sharing its isolate", async () => {
    const miniflare = start(false)
    const left = workspace(miniflare, "ws_left")
    const right = workspace(miniflare, "ws_right")
    const leftSession = await left.create()
    const rightSession = await right.create()
    const watching = await right.stream()
    const leftEvents = await left.stream()

    await left.prompt(leftSession.id, "left secret", "queue")
    await leftEvents.until(idleFor(leftSession.id), "the left turn to go idle")
    await leftEvents.close()
    assert.ok(leftEvents.frames.some((frame) => frame.payload?.type === "session.queue"))

    await right.prompt(rightSession.id, "right")
    await watching.until(idleFor(rightSession.id), "the right turn to go idle")
    await watching.close()

    assert.doesNotMatch(miniflare.stderr(), /workspaceRuntimeBus subscriber failed/)
    const leaked = watching.frames.filter((frame) => JSON.stringify(frame).includes(leftSession.id) || JSON.stringify(frame).includes("left secret"))
    assert.deepEqual(leaked, [])
  })
  void it("ends a turn interrupted by eviction as the store's restart recovery records it, and takes the next prompt", async () => {
    const persist = fs.mkdtempSync(path.join(os.tmpdir(), "wr-session-core-do-"))
    roots.push(persist)
    const first = start(persist)
    const client = workspace(first, "ws_evicted_turn")
    const session = await client.create()
    const live = await client.stream()
    await client.prompt(session.id, "hold: the build")
    await live.until(heldToolRunning(session.id), "the held turn's tool call to start")
    assert.ok(streamedText(live.frames, session.id).includes("working on the build"))

    await first.dispose()
    const reopened = workspace(start(persist), "ws_evicted_turn")

    assert.deepEqual((await reopened.status())[session.id], { type: "recovering", kind: "process_restart", message: RESTART_MESSAGE })
    const interrupted = await reopened.messages(session.id)
    assert.deepEqual(transcript(interrupted), [{ role: "user", text: "hold: the build" }, { role: "assistant", text: "working on the build" }])
    const tool = interrupted[1]!.parts.find((part) => part.callID === "call_held")
    assert.deepEqual([tool?.state?.status, tool?.state?.error], ["error", "Tool execution interrupted by ACP restart"])

    const after = await reopened.stream()
    await reopened.prompt(session.id, "after")
    await after.until(idleFor(session.id), "the next prompt's turn to go idle")
    await after.close()
    assert.deepEqual(transcript(await reopened.messages(session.id)).slice(2), [
      { role: "user", text: "after" },
      { role: "assistant", text: "echo: after" },
    ])
  })

  void it("re-issues a prompt queued behind a turn the eviction interrupted, exactly once", async () => {
    const persist = fs.mkdtempSync(path.join(os.tmpdir(), "wr-session-core-do-"))
    roots.push(persist)
    const first = start(persist)
    const client = workspace(first, "ws_evicted_queue")
    const session = await client.create()
    const live = await client.stream()
    await client.prompt(session.id, "hold: the build")
    await live.until(heldToolRunning(session.id), "the held turn's tool call to start")
    await client.prompt(session.id, "then the tests", "queue")
    assert.equal((await client.queue(session.id)).length, 1)

    await first.dispose()
    const second = start(persist)
    const reopened = workspace(second, "ws_evicted_queue")
    await eventually(async () => (await reopened.messages(session.id)).length === 4, "the queued prompt's turn to be recorded")
    const expected = [
      { role: "user", text: "hold: the build" },
      { role: "assistant", text: "working on the build" },
      { role: "user", text: "then the tests" },
      { role: "assistant", text: "echo: then the tests" },
    ]
    assert.deepEqual(transcript(await reopened.messages(session.id)), expected)
    assert.deepEqual(await reopened.queue(session.id), [])

    await second.dispose()
    const third = workspace(start(persist), "ws_evicted_queue")
    const quiet = await third.stream()
    await quiet.drain(300)
    await quiet.close()
    assert.deepEqual(quiet.frames.filter((frame) => frame.payload?.properties?.sessionID === session.id), [])
    assert.deepEqual(transcript(await third.messages(session.id)), expected)
  })
})
