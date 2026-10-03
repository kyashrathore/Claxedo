import type { ServerConfig } from "./config"
import type { ConnectionState } from "./events"
import { openEventStream, type Stream } from "./stream"
import type { Transport } from "./transport"
import type { BootstrapDeclaration } from "./wire/placements"
import { accountEventResponse } from "./account-event-stream"
import { contractMismatch } from "./errors"

const WORKSPACE_EVENTS_PATH = "/api/wr/events"
const CONTROL_PLANE_EVENTS_PATH = "/api/cp/events"

export type EventStreams = {
  readonly open: (declaration: BootstrapDeclaration) => void
  readonly retry: () => void
  readonly close: () => void
}

function eventSocketResponse(url: URL, headers: Headers, signal: AbortSignal): Promise<Response> {
  const target = new URL(url)
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
  const cursor = headers.get("Last-Event-ID")
  if (cursor) target.searchParams.set("lastEventId", cursor)
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target)
    socket.binaryType = "arraybuffer"
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let ended = false
    const finish = (error?: Error) => {
      if (ended) return
      ended = true
      signal.removeEventListener("abort", abort)
      if (!body) reject(error ?? new Error("The event socket closed before opening"))
      else if (error) body.error(error)
      else body.close()
      socket.close()
    }
    const abort = () => finish(new Error("The event socket was aborted"))
    signal.addEventListener("abort", abort, { once: true })
    socket.onopen = () => {
      if (ended) return
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
        },
        cancel() {
          finish()
        },
      })
      resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    }
    socket.onmessage = (event) => {
      body?.enqueue(typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data as ArrayBuffer))
    }
    socket.onerror = () => finish(new Error("The event socket failed"))
    socket.onclose = (event) => finish(event.code === 1000 ? undefined : new Error(`The event socket closed (${event.code})`))
  })
}

function aggregate(states: readonly ConnectionState[]): ConnectionState {
  const offline = states.find((state) => state.kind === "offline")
  if (offline) return offline
  const reconnecting = states.filter((state): state is Extract<ConnectionState, { kind: "reconnecting" }> => state.kind === "reconnecting")
  if (reconnecting.length > 0) {
    return { kind: "reconnecting", attempt: Math.max(...reconnecting.map((state) => state.attempt)), afterLive: reconnecting.some((state) => state.afterLive) }
  }
  if (states.some((state) => state.kind === "connecting")) return { kind: "connecting" }
  return { kind: "connected" }
}

type StreamsInput = {
  readonly config: ServerConfig
  readonly transport: Transport
  readonly onFrame: (frame: unknown) => void
  readonly onGap: () => void
  readonly onState: (state: ConnectionState) => void
}

function openEventsAt(input: StreamsInput, path: string, socket: boolean, report: () => void): Stream {
  const { transport } = input
  return openEventStream({
    open: ({ headers, signal }) => {
      if (socket) return eventSocketResponse(new URL(path, `${transport.serverUrl}/`), headers, signal)
      return transport.request(path, { headers, signal })
    },
    onFrame: input.onFrame,
    onGap: input.onGap,
    onState: report,
  })
}

export function createEventStreams(input: StreamsInput): EventStreams {
  const { config, transport } = input
  const streams: Stream[] = []
  const report = () => input.onState(aggregate(streams.map((stream) => stream.state())))
  const socket = config.eventSocket === true && transport.loopback
  return {
    open: (declaration) => {
      if (config.account && !config.accountStreams) throw contractMismatch("The signed account stream bridge is missing")
      streams.push(openEventsAt(input, CONTROL_PLANE_EVENTS_PATH, socket, report))
      if (config.accountStreams) streams.push(openEventStream({
        open: async ({ headers, signal }) => accountEventResponse(config.accountStreams!, headers, signal),
        onFrame: input.onFrame,
        onGap: input.onGap,
        onState: report,
      }))
      if (declaration.hostAggregate) streams.push(openEventsAt(input, WORKSPACE_EVENTS_PATH, false, report))
      report()
    },
    retry: () => {
      for (const stream of streams) stream.retry()
    },
    close: () => {
      for (const stream of streams) stream.close()
      streams.length = 0
    },
  }
}
