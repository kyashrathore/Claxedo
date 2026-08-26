import { Database as SQLiteDatabase } from "bun:sqlite"

/**
 * Harness-hosted opencode-engine stand-in for the conversation (stream)
 * profile — the same seam the T3 arm fakes with its replay server.
 *
 * The packaged app launches with OPENCODE_URL pointing here, so its REAL
 * `OpenCodeHarnessAdapter` -> runtime event hub -> claxedo events -> renderer
 * pipeline carries the corpus stream turn. Inventory and transcripts are
 * served straight from the materialized engine SQLite (`dbPath`), so the app
 * sees byte-identical content to the embedded composition. When the app's own
 * prompt reaches `POST /session/{id}/prompt_async`, the corpus stream
 * session's lifecycle events replay over `/global/event` on the corpus
 * timing, ending with a terminal `session.idle`.
 *
 * Response shapes are built from the ADAPTER's parsing contract
 * (`agent-sdk-runtime/src/harnesses/opencode`): `/session` ->
 * `AgentSessionRow[]`, `/session/{id}/message` -> `{ info, parts }[]`,
 * `/global/event` -> SSE lines of `data: {type, properties}` compat events.
 */

type LifecycleEvent = {
  id: string
  sequence: number
  atMs: number
  type: string
  messageId?: string
  partId?: string
  content?: string
  callId?: string
  toolName?: string
  state?: string
  inputJson?: string
  outputText?: string
}

type CorpusLike = {
  sessions: Array<{
    id: string
    order: number
    workspaceId?: string
    events: unknown[]
    turns: Array<{
      messages: Array<{ id: string; role: string; parts: Array<Record<string, unknown> & { id: string; type: string }> }>
    }>
  }>
}

type MaterializedPart = {
  corpusPartId: string
  corpusMessageId: string
  partId: string
  messageId: string
  sessionId: string
  payload: Record<string, unknown>
}

export type FakeEngineEmission = { atMs: number; type: string; partId?: string }

export async function startFakeEngine(input: {
  dbPath: string
  corpus: CorpusLike
  materializedSessions: Map<string, string>
  materializedParts: Map<string, MaterializedPart>
}) {
  const database = new SQLiteDatabase(input.dbPath, { readonly: true })
  const sessions = database
    .prepare("SELECT id, directory, title, slug, time_created, time_updated FROM session")
    .all() as Array<{ id: string; directory: string; title: string; slug: string; time_created: number; time_updated: number }>
  const sessionById = new Map(sessions.map((row) => [row.id, row]))

  const messagesForSession = (sessionId: string) => {
    const messages = database
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC")
      .all(sessionId) as Array<{ id: string; data: string }>
    return messages.map((message) => {
      const parts = database
        .prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC")
        .all(message.id) as Array<{ id: string; data: string }>
      return {
        info: { ...(JSON.parse(message.data) as Record<string, unknown>), id: message.id, sessionID: sessionId },
        parts: parts.map((part) => ({
          ...(JSON.parse(part.data) as Record<string, unknown>),
          id: part.id,
          messageID: message.id,
          sessionID: sessionId,
        })),
      }
    })
  }

  const sessionRow = (row: (typeof sessions)[number]) => ({
    id: row.id,
    slug: row.slug,
    directory: row.directory,
    title: row.title,
    version: "benchmark",
    time: { created: row.time_created, updated: row.time_updated },
  })

  // The stream target: order-sorted first corpus session (same choice as the
  // scenario), with its lifecycle events resolved onto materialized ids.
  const streamCorpusSession = [...input.corpus.sessions].sort((a, b) => a.order - b.order)[0]
  if (!streamCorpusSession) throw new Error("fake engine requires a corpus session")
  const streamSessionId = input.materializedSessions.get(streamCorpusSession.id)
  if (!streamSessionId) throw new Error("fake engine: stream session was not materialized")
  const corpusPartTypes = new Map<string, string>()
  for (const turn of streamCorpusSession.turns) {
    for (const message of turn.messages) {
      for (const part of message.parts) corpusPartTypes.set(part.id, part.type)
    }
  }
  const events = (streamCorpusSession.events as LifecycleEvent[])
    .filter((event) => typeof event.atMs === "number")
    .sort((a, b) => a.sequence - b.sequence)

  const emissions: FakeEngineEmission[] = []
  const clients = new Set<WritableStreamDefaultWriter<Uint8Array>>()
  const encoder = new TextEncoder()
  const emit = (event: { type: string; properties: Record<string, unknown> }, partId?: string) => {
    emissions.push({ atMs: performance.now(), type: event.type, ...(partId ? { partId } : {}) })
    const line = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const writer of clients) void writer.write(line).catch(() => clients.delete(writer))
  }

  let replayStarted = false
  let replayDone: Promise<void> | undefined
  const runReplay = async () => {
    const startedAt = performance.now()
    const announced = new Set<string>()
    for (const event of events) {
      const wait = startedAt + event.atMs - performance.now()
      if (wait > 0) await Bun.sleep(wait)
      if (event.type === "message-part-revision" && event.messageId && event.partId) {
        const materialized = input.materializedParts.get(event.partId)
        if (!materialized) continue
        if (!announced.has(materialized.messageId)) {
          announced.add(materialized.messageId)
          emit({
            type: "message.updated",
            properties: {
              info: { id: materialized.messageId, sessionID: streamSessionId, role: "assistant" },
            },
          })
        }
        const partType = corpusPartTypes.get(event.partId)
        emit(
          {
            type: "message.part.updated",
            properties: {
              part: {
                ...(partType === "reasoning" ? materialized.payload : { type: "text" }),
                text: event.content ?? "",
                id: materialized.partId,
                messageID: materialized.messageId,
                sessionID: streamSessionId,
              },
            },
          },
          materialized.partId,
        )
      } else if (event.type === "tool-lifecycle" && event.callId) {
        const materialized = [...input.materializedParts.values()].find(
          (candidate) => candidate.payload.callID === event.callId,
        )
        if (!materialized) continue
        const status = event.state ?? "completed"
        const parsedInput = JSON.parse(event.inputJson ?? "{}") as Record<string, unknown>
        const state =
          status === "completed"
            ? { status, input: parsedInput, output: event.outputText ?? "", title: event.toolName, metadata: {}, time: { start: 0, end: 1 } }
            : status === "running"
              ? { status, input: parsedInput, time: { start: 0 } }
              : { status: "pending", input: parsedInput, raw: event.inputJson ?? "{}" }
        emit(
          {
            type: "message.part.updated",
            properties: {
              part: {
                type: "tool",
                callID: event.callId,
                tool: event.toolName,
                state,
                id: materialized.partId,
                messageID: materialized.messageId,
                sessionID: streamSessionId,
              },
            },
          },
          materialized.partId,
        )
      }
    }
    emit({ type: "session.idle", properties: { sessionID: streamSessionId } })
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === "/global/event") {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
        const writer = writable.getWriter()
        clients.add(writer)
        void writer.write(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`))
        request.signal.addEventListener("abort", () => {
          clients.delete(writer)
          void writer.close().catch(() => {})
        })
        return new Response(readable, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }
      if (path === "/global/health") return json({ healthy: true })
      if (path === "/session" && request.method === "GET") {
        const directory = request.headers.get("x-opencode-directory")
        const rows = sessions.filter((row) => !directory || row.directory === directory)
        return json(rows.map(sessionRow))
      }
      if (path === "/session/status") return json({})
      if (path === "/mcp") return json(request.method === "GET" ? {} : { ok: true })
      if (path === "/permission" || path === "/question") return json([])
      const sessionMatch = /^\/session\/([^/]+)(.*)$/u.exec(path)
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]!)
        const suffix = sessionMatch[2] ?? ""
        const row = sessionById.get(id)
        if (suffix === "" && request.method === "GET") {
          return row ? json(sessionRow(row)) : json({ error: "not found" }, 404)
        }
        if (suffix === "" && (request.method === "PATCH" || request.method === "DELETE")) {
          return row ? json(sessionRow(row)) : json({}, 200)
        }
        if (suffix === "/message" && request.method === "GET") {
          return json(row ? messagesForSession(id) : [])
        }
        if (suffix === "/prompt_async" && request.method === "POST") {
          if (id === streamSessionId && !replayStarted) {
            replayStarted = true
            replayDone = runReplay()
          }
          return json({ ok: true })
        }
        // abort/command/fork/revert/unrevert/todo and anything else: inert.
        return json(suffix === "/todo" ? [] : { ok: true })
      }
      return json({ error: `unhandled: ${request.method} ${path}` }, 404)
    },
  })

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    streamSessionId,
    expectedEventCount: events.length,
    emissions: () => [...emissions],
    replayFinished: () => replayDone ?? Promise.resolve(),
    promptReceived: () => replayStarted,
    close: () => {
      for (const writer of clients) void writer.close().catch(() => {})
      clients.clear()
      server.stop(true)
      database.close()
    },
  }
}
