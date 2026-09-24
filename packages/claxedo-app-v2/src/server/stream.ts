import { createParser, type EventSourceMessage } from "eventsource-parser"
import { machine, unreachable, type Machine } from "../lib/machine"
import { responseError, ServerError, toAppError } from "./errors"
import type { ConnectionState } from "./events"

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

type StreamRun = {
  readonly options: StreamOptions
  readonly maxAttempts: number
  readonly heartbeatTimeoutMs: number
  readonly connection: Machine<ConnectionState, ConnectionEvent>
  cursor: string | undefined
  closed: boolean
  attempt: AbortController | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  watchdog: ReturnType<typeof setTimeout> | undefined
}

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

function send(run: StreamRun, event: ConnectionEvent) {
  run.connection.send(event)
  run.options.onState?.(run.connection.state())
}

function armWatchdog(run: StreamRun) {
  if (run.watchdog) clearTimeout(run.watchdog)
  run.watchdog = setTimeout(() => run.attempt?.abort(new ServerError({ class: "network", message: "No heartbeat within the timeout" })), run.heartbeatTimeoutMs)
}

function parsedFrame(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch (error) {
    console.error("The event stream sent a frame that is not JSON", { data, error })
    return undefined
  }
}

function deliver(run: StreamRun, message: EventSourceMessage) {
  if (message.id) run.cursor = message.id
  armWatchdog(run)
  const frame = parsedFrame(message.data)
  const type = frame && typeof frame === "object" ? (frame as { type?: unknown }).type : undefined
  if (frame === undefined || type === "heartbeat") return
  if (type === "stream.replay-gap") return run.options.onGap()
  run.options.onFrame(frame)
}

async function readBody(run: StreamRun, body: ReadableStream<Uint8Array>) {
  const parser = createParser({ onEvent: (message) => deliver(run, message) })
  const decoder = new TextDecoder()
  const reader = body.getReader()
  while (!run.closed) {
    const next = await reader.read()
    if (next.done) return
    parser.feed(decoder.decode(next.value, { stream: true }))
  }
}

function scheduleReconnect(run: StreamRun, reason: string) {
  if (run.closed) return
  send(run, { type: "dropped", reason, maxAttempts: run.maxAttempts })
  const state = run.connection.state()
  if (state.kind !== "reconnecting") return
  run.reconnectTimer = setTimeout(() => {
    run.reconnectTimer = undefined
    void connect(run)
  }, reconnectDelayMs(state.attempt - 1))
}

async function openResponse(run: StreamRun, controller: AbortController) {
  const headers = new Headers({ Accept: "text/event-stream" })
  if (run.cursor) headers.set("Last-Event-ID", run.cursor)
  const response = await run.options.open({ headers, signal: controller.signal })
  if (!response.ok) throw await responseError(response, "Event stream")
  if (!response.body) throw new ServerError({ class: "internal", message: "The event stream answered without a body" })
  return response.body
}

async function connect(run: StreamRun) {
  if (run.closed) return
  const controller = new AbortController()
  run.attempt = controller
  try {
    const body = await openResponse(run, controller)
    send(run, { type: "opened" })
    armWatchdog(run)
    await readBody(run, body)
    scheduleReconnect(run, "The event stream ended")
  } catch (error) {
    if (!run.closed && run.attempt === controller) scheduleReconnect(run, toAppError(error).message)
  } finally {
    if (run.watchdog) clearTimeout(run.watchdog)
    run.watchdog = undefined
  }
}

function retry(run: StreamRun) {
  const state = run.connection.state()
  if (run.closed || state.kind === "connected" || state.kind === "connecting") return
  if (state.kind === "reconnecting" && !run.reconnectTimer) return
  if (run.reconnectTimer) clearTimeout(run.reconnectTimer)
  run.reconnectTimer = undefined
  if (state.kind === "offline") send(run, { type: "retry" })
  void connect(run)
}

function close(run: StreamRun) {
  run.closed = true
  run.attempt?.abort(new ServerError({ class: "network", message: "The stream was closed" }))
  if (run.reconnectTimer) clearTimeout(run.reconnectTimer)
  if (run.watchdog) clearTimeout(run.watchdog)
}

export function openStream(options: StreamOptions): Stream {
  const run: StreamRun = {
    options,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    connection: machine<ConnectionState, ConnectionEvent>({ kind: "connecting" }, connectionTransition),
    cursor: undefined,
    closed: false,
    attempt: undefined,
    reconnectTimer: undefined,
    watchdog: undefined,
  }
  void connect(run)
  return { state: run.connection.state, cursor: () => run.cursor, retry: () => retry(run), close: () => close(run) }
}
