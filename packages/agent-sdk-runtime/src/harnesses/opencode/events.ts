import { userMessageIdForAssistantReply, type AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import {
  legacyRuntimeEventFromOpencodeCompat,
  opencodeLegacyOwnsCompatProjection,
} from "@claxedo/agent-event-runtime/opencode-compat"
import {
  eventSessionId,
  isTerminalCompatEvent,
  sessionError,
  toCompatEvent,
  type CompatEvent,
} from "../../compat-events"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { errorMessage } from "../shared/sdk-runtime-values"
import type { OpenCodeRequestFn } from "./index"

export const INCOMPLETE_EVENT_STREAM_MESSAGE = "OpenCode event stream ended before the session completed"

// Synthetic base for the /global/event Request. URL/spawn-mode RequestFns rewrite
// this origin onto the real server URL; injected handlers route on path only.
const OPENCODE_INTERNAL_BASE = "http://opencode.internal"

export type OpenCodeEventStreamHandle = {
  close(): void
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  abortController: AbortController
  ready: Promise<void>
  err?: string
}

/**
 * Publishes one turn's engine feed onto the runtime-events lane.
 *
 * The lane's envelope names the turn's REPLY, and only the reply: a consumer
 * that never saw this turn start recovers the message it answers from that id
 * through the runtime's own convention (`userMessageIdForAssistantReply`). Two
 * things follow, and both are this publisher's job because it is the only
 * place that knows the turn's own ids.
 *
 * The engine names each step's message with an id of its own; the turn's
 * stable reply id is the one this runtime persists and the one the convention
 * can resolve, so every frame of the turn is stamped with it — the same alias
 * `runRuntimeTurn` applies to the compat lane.
 *
 * A frame that belongs to the turn's USER message is not the reply: the
 * prompt's own text part translates to a text delta like any other part, and
 * publishing it as one would file the user's words as the assistant's. It is
 * carried as the prompt it is (`user-message-delta`, naming the message), so a
 * viewer attached to someone else's turn receives BOTH halves of that turn —
 * the reply hangs off the prompt, so a lane that carried only the reply left
 * its consumer with nowhere to put it. The convention names the prompt from
 * the reply id, so that id is all this publisher needs to tell the two apart.
 */
export function createLegacyOpenCodeRuntimePublisher(input: {
  directory: string
  sessionId: string
  assistantMessageId: string
  eventHub?: RuntimeEventHub
}) {
  const content = new Map<string, string>()
  const userMessageId = userMessageIdForAssistantReply(input.assistantMessageId)
  let closed = false

  const publish = (payload: AgentRuntimeEvent) => {
    if (payload.type === "finish" || payload.type === "error") closed = true
    input.eventHub?.publishRuntime({
      directory: input.directory,
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      payload,
    })
  }

  const publisher = (event: CompatEvent) => {
    if (!opencodeLegacyOwnsCompatProjection(input)) return
    const next = legacyRuntimeEventFromOpencodeCompat(event, content)
    if (!next) return
    const payload = userMessageId && next.assistantMessageId === userMessageId
      ? promptChunk(userMessageId, next.payload)
      : next.payload
    if (payload) publish(payload)
  }

  /**
   * Ends the turn on the lane.
   *
   * The turn opens here with `busy`, so it owes a close. The engine's own idle
   * frame is the close whenever it reaches this publisher, but the turn's
   * boundary can be the reply's final `message.updated` — the drain stops
   * there, and the idle behind it never arrives. A consumer whose only carrier
   * is this lane (anyone attached to the turn from elsewhere) would then sit on
   * `busy` forever, so the adapter closes the turn itself when nothing already
   * has.
   */
  publisher.close = () => {
    if (closed) return
    publish({ type: "session-status", status: "idle" })
  }

  return publisher
}

/**
 * One chunk of the turn's prompt, as the lane names it. Only text is carried:
 * a prompt's non-text parts have no `user-message-delta` shape, and inventing
 * one would put content on the lane the engine never described that way.
 */
function promptChunk(userMessageId: string, payload: AgentRuntimeEvent): AgentRuntimeEvent | undefined {
  if (payload.type !== "text-delta") return undefined
  return { type: "user-message-delta", messageId: userMessageId, content: { type: "text", text: payload.delta } }
}

export function openEventStream(request: OpenCodeRequestFn, baseHeaders: Headers): OpenCodeEventStreamHandle {
  const abortController = new AbortController()
  let done = () => {}
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })
  const handle = {
    close: () => abortController.abort(),
    reader: null as ReadableStreamDefaultReader<Uint8Array> | null,
    abortController,
    ready,
    err: undefined as string | undefined,
  }

  request(new Request(`${OPENCODE_INTERNAL_BASE}/global/event`, {
    headers: (() => {
      const headers = new Headers(baseHeaders)
      headers.set("Accept", "text/event-stream")
      return headers
    })(),
    signal: abortController.signal,
  }))
    .then((res) => {
      if (res.ok && res.body) {
        handle.reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
        done()
        return
      }
      handle.err = `Failed to connect to opencode event stream: ${res.status}`
      abortController.abort()
      done()
    })
    .catch((err) => {
      handle.err = errorMessage(err)
      done()
    })

  return handle
}

/**
 * The end of one turn on a session: the engine has stopped producing assistant
 * output and any durable per-turn state it owns (a Goal snapshot, todos) is
 * settled. A per-turn drain stops here; a long-lived watcher re-reads here.
 */
export function isTurnBoundaryCompatEvent(event: CompatEvent): boolean {
  if (isTerminalCompatEvent(event)) return true
  return (
    event.type === "message.updated"
    && event.properties.info.role === "assistant"
    && "finish" in event.properties.info
    && Boolean(event.properties.info.finish)
  )
}

/** One session's slice of the server feed, ending at that session's turn boundary. */
export async function* drainEventStream(
  handle: OpenCodeEventStreamHandle,
  sessionId: string,
): AsyncIterable<CompatEvent> {
  await handle.ready
  if (!handle.reader) {
    yield sessionError(handle.err ?? "Failed to connect to opencode event stream", sessionId)
    return
  }

  try {
    for await (const event of readCompatEvents(handle.reader)) {
      const evtSessionId = eventSessionId(event)
      if (evtSessionId && evtSessionId !== sessionId) continue
      yield event
      if (isTurnBoundaryCompatEvent(event)) return
    }
    yield sessionError(INCOMPLETE_EVENT_STREAM_MESSAGE, sessionId)
  } finally {
    handle.close()
  }
}

/**
 * The whole server feed, unfiltered and open until the server closes it. Callers
 * that watch several sessions at once share ONE of these instead of opening a
 * copy of `/global/event` each; a connection failure surfaces as a throw so the
 * caller owns its own reconnect policy.
 */
export async function* drainServerEventStream(handle: OpenCodeEventStreamHandle): AsyncIterable<CompatEvent> {
  await handle.ready
  if (!handle.reader) throw new Error(handle.err ?? "Failed to connect to opencode event stream")
  try {
    yield* readCompatEvents(handle.reader)
  } finally {
    handle.close()
  }
}

async function* readCompatEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<CompatEvent> {
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (!raw) continue
        let event: CompatEvent | null = null
        try {
          const raw_data = JSON.parse(raw) as {
            payload?: unknown
            type?: string
            properties?: Record<string, unknown>
          }
          event = toCompatEvent(raw_data.payload ?? raw_data)
        } catch {
          // A malformed frame is not a stream failure; skip it.
        }
        if (event) yield event
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
