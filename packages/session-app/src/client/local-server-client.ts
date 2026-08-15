/**
 * Thin client for the local Claxedo server / workspace runtime — the endpoints
 * discovered from `workspace-runtime/src/routes/session-core.ts` and
 * `routes/runtime-events.ts`:
 *
 *   GET  /session?directory=…          list sessions
 *   POST /session                      create (accepts a harness)
 *   GET  /session/:id/message          stored transcript
 *   POST /session/:id/message          send a prompt (runs the turn)
 *   GET  /api/wr/runtime-events        SSE of {sessionId, directory, payload}
 *
 * All I/O is injected (`fetch`, an SSE reader) so the module stays runnable
 * anywhere and trivially fakeable in tests. Unsigned local only: no auth
 * headers, by design.
 */

import type { RuntimeEventEnvelope } from "../core/events"
import { decodeTranscript } from "../core/update"
import type { TranscriptMessage } from "../core/model"

export type SessionSummary = {
  id: string
  title?: string
  directory?: string
}

export type LocalServerClient = {
  /**
   * Registers/resolves the directory as a local workspace on the control
   * plane (`GET /api/claxedo/workspace/resolve?directory=…`). On the desktop-
   * local server the session routes are dispatched per-workspace, so this
   * must run once before them; servers without the route (bare
   * workspace-runtime, the fake dev runtime) return 404 and the client
   * treats that as "no resolution needed".
   */
  resolveWorkspace(directory: string): Promise<void>
  listSessions(directory: string): Promise<SessionSummary[]>
  createSession(input: { directory: string; harness?: string; title?: string }): Promise<SessionSummary>
  loadTranscript(sessionId: string, directory: string): Promise<TranscriptMessage[]>
  /**
   * Sends a prompt. Beyond the text, the input carries the composer's
   * selection using the EXACT field names of the server's `SessionPromptBody`
   * (workspace-runtime/src/session/service.ts): `model: {providerID,
   * modelID}`, `agent`, `variant` (reasoning effort), `permissionMode`.
   * Absent fields are omitted from the body, never sent as null.
   */
  sendPrompt(input: {
    sessionId: string
    directory: string
    text: string
    model?: { providerID: string; modelID: string }
    agent?: string
    variant?: string
    permissionMode?: string
    messageID?: string
  }): Promise<void>
  /**
   * Subscribes to the runtime-event stream. Returns a disposer. The reader
   * reconnects with backoff; connection state changes surface through
   * `onConnection` so the model can render them.
   */
  subscribeRuntimeEvents(input: {
    directory: string
    onEnvelope: (envelope: RuntimeEventEnvelope) => void
    onConnection: (state: "connecting" | "live" | "closed" | "error") => void
  }): () => void
}

export function createLocalServerClient(options: {
  baseUrl: string
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
}): LocalServerClient {
  const fetcher = options.fetcher ?? ((url, init) => globalThis.fetch(url, init))
  const url = (path: string, query: Record<string, string> = {}) => {
    const u = new URL(path, options.baseUrl)
    for (const [key, value] of Object.entries(query)) u.searchParams.set(key, value)
    return u.href
  }

  async function json<T>(response: Response): Promise<T> {
    if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`)
    return (await response.json()) as T
  }

  return {
    async resolveWorkspace(directory) {
      // create=true: same call ensureLocalProject makes — registers the
      // directory as a local workspace when it isn't one yet.
      const response = await fetcher(url("/api/claxedo/workspace/resolve", { directory, create: "true" }))
      if (response.status === 404) return
      if (!response.ok) throw new Error(`workspace resolve failed: ${response.status}`)
    },

    async listSessions(directory) {
      const body = await json<unknown>(await fetcher(url("/session", { directory })))
      if (!Array.isArray(body)) return []
      return body.flatMap((item): SessionSummary[] => {
        if (!item || typeof item !== "object") return []
        const record = item as { id?: unknown; title?: unknown; directory?: unknown }
        if (typeof record.id !== "string") return []
        return [{
          id: record.id,
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          ...(typeof record.directory === "string" ? { directory: record.directory } : {}),
        }]
      })
    },

    async createSession(input) {
      const body = await json<{ id?: unknown; title?: unknown }>(
        await fetcher(url("/session", { directory: input.directory }), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            directory: input.directory,
            ...(input.harness ? { harness: input.harness } : {}),
            ...(input.title ? { title: input.title } : {}),
          }),
        }),
      )
      if (typeof body.id !== "string") throw new Error("create session: response carried no id")
      return { id: body.id, ...(typeof body.title === "string" ? { title: body.title } : {}) }
    },

    async loadTranscript(sessionId, directory) {
      const body = await json<unknown>(
        await fetcher(url(`/session/${encodeURIComponent(sessionId)}/message`, { directory })),
      )
      return decodeTranscript(body)
    },

    async sendPrompt(input) {
      await json<unknown>(
        await fetcher(url(`/session/${encodeURIComponent(input.sessionId)}/message`, { directory: input.directory }), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: input.text }],
            ...(input.model ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } } : {}),
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.variant ? { variant: input.variant } : {}),
            ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
            ...(input.messageID ? { messageID: input.messageID } : {}),
          }),
        }),
      )
    },

    subscribeRuntimeEvents(input) {
      let disposed = false
      let attempt = 0
      let abort: AbortController | undefined

      const connect = async () => {
        while (!disposed) {
          input.onConnection(attempt === 0 ? "connecting" : "error")
          abort = new AbortController()
          try {
            const response = await fetcher(url("/api/wr/runtime-events", { directory: input.directory }), {
              headers: { accept: "text/event-stream" },
              signal: abort.signal,
            })
            if (!response.ok || !response.body) throw new Error(`stream ${response.status}`)
            input.onConnection("live")
            attempt = 0
            await readSseStream(response.body, (data) => {
              const envelope = decodeEnvelope(data)
              if (envelope) input.onEnvelope(envelope)
            })
            if (!disposed) input.onConnection("closed")
          } catch {
            if (disposed) return
          }
          attempt += 1
          await delay(Math.min(500 * 2 ** attempt, 8_000))
        }
      }
      void connect()

      return () => {
        disposed = true
        abort?.abort()
        input.onConnection("closed")
      }
    },
  }
}

function decodeEnvelope(data: string): RuntimeEventEnvelope | undefined {
  try {
    const parsed = JSON.parse(data) as Partial<RuntimeEventEnvelope>
    if (typeof parsed.sessionId !== "string") return undefined
    if (!parsed.payload || typeof parsed.payload !== "object" || typeof parsed.payload.type !== "string") return undefined
    return { sessionId: parsed.sessionId, directory: typeof parsed.directory === "string" ? parsed.directory : "", payload: parsed.payload }
  } catch {
    return undefined
  }
}

/** Minimal SSE parser: `data:` lines accumulate, a blank line dispatches. */
export async function readSseStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (line === "") {
        if (data.length) onData(data.join("\n"))
        data = []
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart())
      }
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
