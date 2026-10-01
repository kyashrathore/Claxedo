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

const FIXTURE = fileURLToPath(new URL("./test-support/session-core-durable-object.ts", import.meta.url))
const PACKAGES = path.resolve(import.meta.dirname, "../..")
const DIRECTORY = "/workspace"
const WORKSPACE_HEADER = "x-workspace-id"

/**
 * Every Node builtin the Durable Object's bundle still imports, each one a
 * port the host has yet to supply (docs/session-core-durable-object.md). The
 * worker runs with `nodejs_compat` for these; the list is exact, so an import
 * that joins the closure or leaves it fails here until the note and this list
 * say so.
 */
const REVIEWED_NODE_IMPORTS = [
  "async_hooks <- workspace-runtime/src/target.ts",
  "node:buffer <- claxedo-helpers/src/fs.ts",
  "node:buffer <- claxedo-helpers/src/windows-private-file.ts",
  "node:child_process <- claxedo-helpers/src/windows-private-file.ts",
  "node:crypto <- claxedo-helpers/src/fs.ts",
  "node:crypto <- harness/src/broker/subagents/admission.ts",
  "node:crypto <- harness/src/broker/subagents/index.ts",
  "node:crypto <- workspace-runtime/src/routes/document-hydration.ts",
  "node:crypto <- workspace-runtime/src/routes/session-children.ts",
  "node:fs <- claxedo-helpers/src/fs.ts",
  "node:fs <- claxedo-helpers/src/real-path.ts",
  "node:fs <- workspace-runtime/src/routes/document-hydration-files.ts",
  "node:fs <- workspace-runtime/src/routes/document-hydration.ts",
  "node:fs <- workspace-runtime/src/routes/tool-image.ts",
  "node:fs/promises <- claxedo-helpers/src/fs.ts",
  "node:fs/promises <- harness/src/contract/probe-cache.ts",
  "node:fs/promises <- workspace-runtime/src/routes/document-hydration-files.ts",
  "node:fs/promises <- workspace-runtime/src/routes/document-hydration.ts",
  "node:fs/promises <- workspace-runtime/src/routes/tool-image.ts",
  "node:fs/promises <- workspace-runtime/src/target.ts",
  "node:os <- claxedo-helpers/src/path.ts",
  "node:path <- claxedo-helpers/src/fs.ts",
  "node:path <- claxedo-helpers/src/path.ts",
  "node:path <- claxedo-helpers/src/real-path.ts",
  "node:path <- claxedo-helpers/src/windows-private-file.ts",
  "node:path <- workspace-runtime/src/env.ts",
  "node:path <- workspace-runtime/src/routes/document-hydration-files.ts",
  "node:path <- workspace-runtime/src/routes/document-hydration.ts",
  "node:path <- workspace-runtime/src/routes/events.ts",
  "node:path <- workspace-runtime/src/routes/tool-image.ts",
  "path <- workspace-runtime/src/target.ts",
]

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
    compatibilityFlags: ["nodejs_compat"],
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

type StoredMessage = { info: { id: string; role: string }; parts: Array<{ type: string; text?: string }> }

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
    return {
      frames,
      async until(done: (frames: Frame[]) => boolean) {
        while (!done(frames)) if (!await read()) throw new Error(`${workspaceId}'s stream ended first`)
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
  }
}

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

  void it("reaches only the reviewed Node builtins", () => {
    assert.deepEqual([...reached].sort(), REVIEWED_NODE_IMPORTS)
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
    await events.until(idleFor(session.id))
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
    await resumed.until(idleFor(session.id))
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
    await leftEvents.until(idleFor(leftSession.id))
    await leftEvents.close()
    assert.ok(leftEvents.frames.some((frame) => frame.payload?.type === "session.queue"))

    await right.prompt(rightSession.id, "right")
    await watching.until(idleFor(rightSession.id))
    await watching.close()

    assert.doesNotMatch(miniflare.stderr(), /workspaceRuntimeBus subscriber failed/)
    const leaked = watching.frames.filter((frame) => JSON.stringify(frame).includes(leftSession.id) || JSON.stringify(frame).includes("left secret"))
    assert.deepEqual(leaked, [])
  })
})
