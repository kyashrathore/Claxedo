import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import type { LiveSyncRoomNamespace } from "../../platform/http/live-sync-publish"
import {
  HEADER_CURSOR, HEARTBEAT, SSE_HEADERS, SSE_QUEUE_LIMIT,
  liveSyncRoomConnectHeaders, liveSyncRoomName,
  type LiveSyncSocket, type LiveSyncSubscriber,
} from "./live-sync-protocol"

function socketFromResponse(response: Response) {
  return (response as Response & { webSocket?: LiveSyncSocket }).webSocket
}

function sameSubscriber(left: LiveSyncSubscriber, right: LiveSyncSubscriber) {
  if (left.auth.mode !== right.auth.mode) return false
  if (left.auth.mode === "unsigned-local" || right.auth.mode === "unsigned-local") return true
  if (left.auth.user.subject !== right.auth.user.subject) return false
  return left.auth.user.orgId === right.auth.user.orgId && left.orgId === right.orgId
}

export type LiveSyncReauthorization = {
  intervalMs: number
  current: () => Promise<LiveSyncSubscriber>
}

/**
 * Route a resolved subscriber's client connection to their room. Production
 * rooms return a hibernatable WebSocket; this function bridges it back to the
 * browser's existing SSE response, writes its heartbeats and runs its
 * reauthorization (comparing fresh the identity provider claims against
 * `subscriber.auth` — a claims change closes the stream so the client
 * reconnects and re-resolves its org). The two run on separate timers.
 */
export function connectLiveSyncRoom(
  namespace: LiveSyncRoomNamespace,
  subscriber: LiveSyncSubscriber,
  heartbeatMs?: number,
  reauthorization?: LiveSyncReauthorization,
  lastEventId?: string,
): Promise<Response> {
  return namespace
    .get(namespace.idFromName(liveSyncRoomName(subscriber)))
    .fetch(
      new Request("https://live-sync-room.internal/connect", {
        method: "GET",
        headers: {
          ...liveSyncRoomConnectHeaders(subscriber, heartbeatMs, lastEventId),
          upgrade: "websocket",
          connection: "Upgrade",
        },
      }),
    )
    .then((response) => {
      const socket = socketFromResponse(response)
      // No socket means the room answered with its own SSE body (the Node/test
      // fallback), which already carries its bootstrap frame and replay.
      if (!socket) return response
      const encoder = new TextEncoder()
      // The room computes the resume cursor because a cursor-less client
      // resumes at the room's `lastId()`. Falling back to the caller's own
      // cursor keeps a resuming client exact if the header is ever lost; a
      // cursor-less one would then be handed "0", which on this stream costs a
      // redundant replay of retained doorbells, not a resurrected dock.
      const cursor = response.headers.get(HEADER_CURSOR) ?? lastEventId ?? "0"
      const intervalMs = heartbeatMs && Number.isFinite(heartbeatMs) && heartbeatMs > 0
        ? Math.floor(heartbeatMs)
        : EVENT_STREAM_HEARTBEAT_MS
      let stopped = false
      let beatTimer: ReturnType<typeof setTimeout> | undefined
      let reauthorizeTimer: ReturnType<typeof setTimeout> | undefined
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined

      const later = (run: () => void, ms: number) => {
        const timer = setTimeout(run, ms)
        ;(timer as { unref?: () => void }).unref?.()
        return timer
      }
      const stop = (error?: unknown, settleStream = true) => {
        if (stopped) return
        stopped = true
        if (beatTimer !== undefined) clearTimeout(beatTimer)
        if (reauthorizeTimer !== undefined) clearTimeout(reauthorizeTimer)
        socket.close(error ? 1011 : 1000, error ? "live-sync stream failed" : "live-sync stream closed")
        if (!controller || !settleStream) return
        if (error) controller.error(error)
        else controller.close()
      }
      const write = (data: unknown, id?: string) => {
        if (!controller || stopped) return false
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          stop(new Error("live-sync client is too slow"))
          return false
        }
        const body = typeof data === "string" ? data : JSON.stringify(data)
        controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}data: ${body}\n\n`))
        return true
      }
      /**
       * Unwrap the internal id-carrying envelope back into the public wire the
       * hosted client already reads: the bare event JSON on `data:`, with `id:`
       * as its own line. claxedo-app captures `id:` before it decides whether a
       * frame has a payload it cares about, so an unhandled frame still
       * advances the cursor correctly.
       */
      const writeMessage = (raw: string) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return write(raw)
        }
        const envelope = asRecord(parsed)
        if (envelope && "frame" in envelope && typeof envelope.id === "string") {
          return write(envelope.frame, envelope.id)
        }
        return write(raw)
      }
      const beat = () => {
        if (stopped) return
        try {
          if (!write(HEARTBEAT)) return
          beatTimer = later(beat, intervalMs)
        } catch (error) {
          stop(error)
        }
      }
      const reauthorize = async (check: LiveSyncReauthorization) => {
        if (stopped) return
        let current: LiveSyncSubscriber
        try {
          current = await check.current()
        } catch {
          // Bearer tokens outlive nothing: a five-minute access token will
          // expire under a long-lived stream, and the re-check then throws
          // an AuthenticationError with the response already streaming — no
          // 401 can exist anymore. That is the client's cue to reconnect
          // with a fresh token, not a server failure: erroring the stream
          // here would end every wr/events invocation as an uncaught
          // exception on a five-minute cycle. Close cleanly instead; the
          // client's reconnect performs a full, fresh authorization.
          stop()
          return
        }
        if (!sameSubscriber(subscriber, current)) {
          // Same shape for a subscriber whose authorization changed (org
          // moved, actor revoked): the reconnect re-authorizes from scratch
          // and lands in the right room — or is refused with a real 401.
          stop()
          return
        }
        if (!stopped) reauthorizeTimer = later(() => void reauthorize(check), check.intervalMs)
      }

      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
          socket.addEventListener("message", (event) => {
            const data = "data" in event ? event.data : undefined
            if (typeof data === "string") writeMessage(data)
            else if (data instanceof ArrayBuffer) writeMessage(new TextDecoder().decode(data))
          })
          socket.addEventListener("close", () => stop())
          socket.addEventListener("error", () => stop(new Error("live-sync room socket failed")))
          // The bootstrap frame is written before `accept()`, not after. The
          // room has already queued this connection's replayed frames on the
          // socket, and accepting is what releases them; writing the cursor
          // first is the only ordering that guarantees a replayed frame can
          // never precede the bootstrap and walk the reader's cursor forward
          // past frames it has not received.
          write(HEARTBEAT, cursor)
          socket.accept?.()
          beatTimer = later(beat, intervalMs)
          if (reauthorization) {
            reauthorizeTimer = later(() => void reauthorize(reauthorization), reauthorization.intervalMs)
          }
        },
        cancel() {
          stop(undefined, false)
        },
      }, { highWaterMark: SSE_QUEUE_LIMIT })
      return new Response(body, { headers: SSE_HEADERS })
    })
}
