import { createParser } from "eventsource-parser"
import { machine, unreachable } from "@/lib/machine"
import type { ConnectionState } from "./events"
import { toAppError } from "./errors"

export type StreamOptions = {
  readonly open: (init: { readonly headers: Headers; readonly signal: AbortSignal }) => Promise<Response>
  readonly onFrame: (frame: unknown) => void
  readonly onGap: () => void
  readonly onState?: (state: ConnectionState) => void
  readonly maxAttempts?: number
  readonly heartbeatTimeoutMs?: number
}

export type Stream = {
  readonly state: () => ConnectionState
  readonly cursor: () => string | undefined
  readonly retry: () => void
  readonly close: () => void
}

type ConnectionEvent =
  | { readonly type: "opened" }
  | { readonly type: "dropped"; readonly reason: string; readonly maxAttempts: number }
  | { readonly type: "retry" }

export const RECONNECT_BASE_MS = 250
export const RECONNECT_CEILING_MS = 15_000
export const DEFAULT_MAX_ATTEMPTS = 10
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000

export function reconnectDelayMs(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(RECONNECT_CEILING_MS, RECONNECT_BASE_MS * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export function connectionTransition(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (event.type) {
    case "opened":
      return { kind: "connected" }
    case "retry":
      return state.kind === "offline" ? { kind: "connecting" } : state
    case "dropped": {
      const attempt = state.kind === "reconnecting" ? state.attempt + 1 : 1
      if (attempt > event.maxAttempts) return { kind: "offline", reason: event.reason }
      return { kind: "reconnecting", attempt }
    }
    default:
      return unreachable(event)
  }
}

function frameOf(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

function frameType(frame: unknown) {
  return frame && typeof frame === "object" ? (frame as { type?: unknown }).type : undefined
}

export function openStream(options: StreamOptions): Stream {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const connection = machine<ConnectionState, ConnectionEvent>({ kind: "connecting" }, connectionTransition)
  let cursor: string | undefined
  let closed = false
  let attempt: AbortController | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined

  const send = (event: ConnectionEvent) => {
    connection.send(event)
    options.onState?.(connection.state())
  }

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => attempt?.abort(new Error("No heartbeat within the timeout")), heartbeatTimeoutMs)
  }

  const deliver = (message: { id?: string; data: string }) => {
    if (message.id) cursor = message.id
    armWatchdog()
    const frame = frameOf(message.data)
    const type = frameType(frame)
    if (frame === undefined || type === "heartbeat") return
    if (type === "stream.replay-gap") {
      options.onGap()
      return
    }
    options.onFrame(frame)
  }

  const readBody = async (body: ReadableStream<Uint8Array>) => {
    const parser = createParser({ onEvent: deliver })
    const decoder = new TextDecoder()
    const reader = body.getReader()
    while (!closed) {
      const next = await reader.read()
      if (next.done) return
      parser.feed(decoder.decode(next.value, { stream: true }))
    }
  }

  const scheduleReconnect = (reason: string) => {
    if (closed) return
    send({ type: "dropped", reason, maxAttempts })
    const state = connection.state()
    if (state.kind !== "reconnecting") return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, reconnectDelayMs(state.attempt - 1))
  }

  const connect = async () => {
    if (closed) return
    const controller = new AbortController()
    attempt = controller
    const headers = new Headers({ Accept: "text/event-stream" })
    if (cursor) headers.set("Last-Event-ID", cursor)
    try {
      const response = await options.open({ headers, signal: controller.signal })
      if (!response.ok || !response.body) throw toAppError(new Error(`The event stream answered ${response.status}`))
      send({ type: "opened" })
      armWatchdog()
      await readBody(response.body)
      if (!closed) scheduleReconnect("The event stream ended")
    } catch (error) {
      if (closed || attempt !== controller) return
      scheduleReconnect(toAppError(error).message)
    } finally {
      if (watchdog) clearTimeout(watchdog)
      watchdog = undefined
    }
  }

  void connect()

  return {
    state: connection.state,
    cursor: () => cursor,
    retry: () => {
      if (closed) return
      const state = connection.state()
      if (state.kind === "connected" || state.kind === "connecting") return
      if (state.kind === "reconnecting" && !reconnectTimer) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (state.kind === "offline") send({ type: "retry" })
      void connect()
    },
    close: () => {
      closed = true
      attempt?.abort(new Error("The stream was closed"))
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (watchdog) clearTimeout(watchdog)
    },
  }
}
