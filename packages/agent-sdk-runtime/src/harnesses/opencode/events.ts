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

export function createLegacyOpenCodeRuntimePublisher(input: {
  directory: string
  sessionId: string
  assistantMessageId: string
  eventHub?: RuntimeEventHub
}) {
  const content = new Map<string, string>()

  return (event: CompatEvent) => {
    if (!opencodeLegacyOwnsCompatProjection(input)) return
    const next = legacyRuntimeEventFromOpencodeCompat(event, content)
    if (!next) return
    input.eventHub?.publishRuntime({
      directory: input.directory,
      sessionId: input.sessionId,
      assistantMessageId: next.assistantMessageId ?? input.assistantMessageId,
      payload: next.payload,
    })
  }
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
      handle.err = err instanceof Error ? err.message : String(err)
      done()
    })

  return handle
}

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
    yield* subscribeGlobalEventsFromReader(handle.reader, sessionId)
  } finally {
    handle.close()
  }
}

async function* subscribeGlobalEventsFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
): AsyncIterable<CompatEvent> {
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        yield sessionError(INCOMPLETE_EVENT_STREAM_MESSAGE, sessionId)
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (!raw) continue
        try {
          const raw_data = JSON.parse(raw) as {
            payload?: unknown
            type?: string
            properties?: Record<string, unknown>
          }
          const event = toCompatEvent(raw_data.payload ?? raw_data)
          if (!event) continue
          const evtSessionId = eventSessionId(event)
          if (evtSessionId && evtSessionId !== sessionId) continue
          yield event
          if (
            event.type === "message.updated"
            && event.properties.info.role === "assistant"
            && "finish" in event.properties.info
            && event.properties.info.finish
          ) return
          if (isTerminalCompatEvent(event)) return
        } catch {
          // ignore
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
