import { batch } from "solid-js"
import { createParser, type EventSourceMessage } from "eventsource-parser"
import { EVENT_STREAM_STALL_TIMEOUT_MS } from "@claxedo/agent-event-runtime/contracts"
import { machine, unreachable, type Machine } from "../lib/machine"
import { responseError, ServerError, toAppError } from "./errors"
import type { ConnectionState } from "./events"
import { streamSignalOf } from "./wire/stream-signals"

export type StreamOptions = {
  readonly open: (init: { readonly headers: Headers; readonly signal: AbortSignal }) => Promise<Response>
  readonly onFrame: (frame: unknown) => void
  readonly onGap: () => void
  readonly onState?: (state: ConnectionState) => void
  readonly onRefused?: (error: ServerError) => void
}

export type Stream = {
  readonly state: () => ConnectionState
  readonly cursor: () => string | undefined
  readonly retry: () => void
  readonly close: () => void
}

type ConnectionEvent = { readonly type: "opened" } | { readonly type: "dropped" } | { readonly type: "refused"; readonly reason: string }

type StreamRun = {
  readonly options: StreamOptions
  readonly connection: Machine<ConnectionState, ConnectionEvent>
  cursor: string | undefined
  closed: boolean
  attempt: AbortController | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  watchdog: ReturnType<typeof setTimeout> | undefined
}

const RECONNECT_BASE_MS = 250
const RECONNECT_CEILING_MS = 15_000

function reconnectDelayMs(attempt: number, random: () => number = Math.random) {
  const ceiling = Math.min(RECONNECT_CEILING_MS, RECONNECT_BASE_MS * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

function connectionTransition(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (event.type) {
    case "opened":
      return { kind: "connected" }
    case "dropped": {
      const attempt = state.kind === "reconnecting" ? state.attempt + 1 : 1
      const afterLive = state.kind === "connected" || (state.kind === "reconnecting" && state.afterLive)
      return { kind: "reconnecting", attempt, afterLive }
    }
    case "refused":
      return { kind: "offline", reason: event.reason }
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
  run.watchdog = setTimeout(() => run.attempt?.abort(new ServerError({ class: "network", message: "No heartbeat within the timeout" })), EVENT_STREAM_STALL_TIMEOUT_MS)
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
  if (frame === undefined) return
  const signal = streamSignalOf(frame)
  if (signal === "heartbeat") return
  if (signal === "replayGap") return run.options.onGap()
  run.options.onFrame(frame)
}

async function readBody(run: StreamRun, body: ReadableStream<Uint8Array>) {
  const parser = createParser({ onEvent: (message) => deliver(run, message) })
  const decoder = new TextDecoder()
  const reader = body.getReader()
  while (!run.closed) {
    const next = await reader.read()
    if (next.done) return
    batch(() => parser.feed(decoder.decode(next.value, { stream: true })))
  }
}

function scheduleReconnect(run: StreamRun) {
  if (run.closed) return
  send(run, { type: "dropped" })
  const state = run.connection.state()
  if (state.kind !== "reconnecting") return
  run.reconnectTimer = setTimeout(() => {
    run.reconnectTimer = undefined
    void openStreamAttempt(run)
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

async function openStreamAttempt(run: StreamRun) {
  if (run.closed) return
  const controller = new AbortController()
  run.attempt = controller
  try {
    const body = await openResponse(run, controller)
    send(run, { type: "opened" })
    armWatchdog(run)
    await readBody(run, body)
    scheduleReconnect(run)
  } catch (error) {
    if (run.closed || run.attempt !== controller) return
    const reason = toAppError(error)
    if (reason.status === 403) return endRefusedStream(run, reason)
    console.error("The event stream dropped", reason)
    scheduleReconnect(run)
  } finally {
    if (run.watchdog) clearTimeout(run.watchdog)
    run.watchdog = undefined
  }
}

function endRefusedStream(run: StreamRun, reason: ServerError) {
  send(run, { type: "refused", reason: reason.message })
  run.options.onRefused?.(reason)
}

function retry(run: StreamRun) {
  const state = run.connection.state()
  if (run.closed || state.kind === "connected" || state.kind === "connecting" || state.kind === "offline") return
  if (state.kind === "reconnecting" && !run.reconnectTimer) return
  if (run.reconnectTimer) clearTimeout(run.reconnectTimer)
  run.reconnectTimer = undefined
  void openStreamAttempt(run)
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
    connection: machine<ConnectionState, ConnectionEvent>({ kind: "connecting" }, connectionTransition),
    cursor: undefined,
    closed: false,
    attempt: undefined,
    reconnectTimer: undefined,
    watchdog: undefined,
  }
  void openStreamAttempt(run)
  return { state: run.connection.state, cursor: () => run.cursor, retry: () => retry(run), close: () => close(run) }
}
