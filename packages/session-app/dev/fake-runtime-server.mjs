// Deterministic runtime for session-app verification: speaks the same wire
// contract as @claxedo/workspace-runtime (GET/POST /session, GET/POST
// /session/:id/message, SSE /api/wr/runtime-events) and answers every prompt
// by replaying a scripted AgentRuntimeEvent turn — streaming text deltas, a
// tool call, todos, a finish. No harness, no credentials: this exercises the
// renderer's full event-driven path end to end. The REAL server check happens
// separately against the workspace-runtime CLI; this one makes the streaming
// verification reproducible.
//
//   node dev/fake-runtime-server.mjs [port]

import { createServer } from "node:http"
import { randomUUID } from "node:crypto"

const port = Number(process.argv[2] ?? 4470)
const directory = "/tmp/session-app-demo"
const sessions = new Map() // id -> { id, title, messages: [{info, parts}] }
const subscribers = new Set() // http responses with SSE open

function seed() {
  const id = "ses_demo"
  sessions.set(id, {
    id,
    title: "Demo session",
    messages: [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "What does this repo do?" }] },
      {
        info: { id: "m2", role: "assistant" },
        parts: [{ type: "text", text: "It is **Claxedo** — an agent workbench.\n\n- sessions\n- terminals\n\n```ts\nconst x = 1\n```" }],
      },
    ],
  })
}
seed()

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  })
  res.write(":ok\n\n")
  subscribers.add(res)
  res.on("close", () => subscribers.delete(res))
}

function emit(sessionId, payload) {
  const frame = `data: ${JSON.stringify({ sessionId, directory, payload })}\n\n`
  for (const res of subscribers) res.write(frame)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function replayTurn(sessionId, promptText) {
  const messageId = `m${randomUUID().slice(0, 8)}`
  emit(sessionId, { type: "session-status", status: "busy" })
  await sleep(120)
  emit(sessionId, { type: "thinking-delta", delta: "The user asked: " + promptText.slice(0, 60) })
  await sleep(150)
  emit(sessionId, { type: "step-start", newMessageId: messageId })
  const chunks = "Here is a **streamed** answer.\n\nIt arrives token by token, exercises `markdown`, and then runs a tool:\n".split(/(?<= )/)
  for (const chunk of chunks) {
    emit(sessionId, { type: "text-delta", delta: chunk })
    await sleep(35)
  }
  const toolCallId = randomUUID().slice(0, 8)
  emit(sessionId, { type: "tool-start", toolCallId, toolName: "bash", display: { summary: "ls -la" } })
  emit(sessionId, { type: "tool-status", toolCallId, status: "running" })
  await sleep(400)
  emit(sessionId, { type: "tool-status", toolCallId, status: "completed" })
  emit(sessionId, {
    type: "todo-update",
    todos: [
      { id: "1", description: "Read the request", status: "completed" },
      { id: "2", description: "Stream the answer", status: "in_progress" },
    ],
  })
  for (const chunk of "\nDone — that was the whole demo turn.".split(/(?<= )/)) {
    emit(sessionId, { type: "text-delta", delta: chunk })
    await sleep(35)
  }
  emit(sessionId, { type: "finish", sessionId })
  emit(sessionId, { type: "session-status", status: "idle" })

  const session = sessions.get(sessionId)
  session?.messages.push(
    { info: { id: `u${Date.now()}`, role: "user" }, parts: [{ type: "text", text: promptText }] },
    { info: { id: messageId, role: "assistant" }, parts: [{ type: "text", text: "Here is a streamed answer. (persisted form)" }] },
  )
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let data = ""
  for await (const chunk of req) data += chunk
  try {
    return JSON.parse(data)
  } catch {
    return {}
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST",
      "access-control-allow-headers": "content-type,accept",
    })
    return res.end()
  }
  if (url.pathname === "/api/wr/runtime-events") return sse(res)
  if (url.pathname === "/session" && req.method === "GET") {
    return json(res, [...sessions.values()].map(({ id, title }) => ({ id, title, directory })))
  }
  if (url.pathname === "/session" && req.method === "POST") {
    const id = `ses_${randomUUID().slice(0, 8)}`
    sessions.set(id, { id, title: "New session", messages: [] })
    return json(res, { id, title: "New session" })
  }
  const message = url.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (message) {
    const session = sessions.get(decodeURIComponent(message[1]))
    if (!session) return json(res, { error: "unknown session" }, 404)
    if (req.method === "GET") return json(res, session.messages)
    const body = await readBody(req)
    const text = (body.parts ?? []).map((part) => part.text ?? "").join("")
    void replayTurn(session.id, text || "(empty)")
    return json(res, { ok: true })
  }
  json(res, { error: "not found" }, 404)
}).listen(port, "127.0.0.1", () => {
  console.log(`fake runtime on http://127.0.0.1:${port} (directory: ${directory}, seeded session: ses_demo)`)
})
