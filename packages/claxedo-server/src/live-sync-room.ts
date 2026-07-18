/**
 * `LiveSyncRoom` — the per-owner Durable Object that HOLDS hibernatable
 * WebSocket connections and can be rung from any Worker isolate. The public
 * Worker route bridges that internal socket to the browser's signed SSE
 * contract, so the Durable Object can park without a client migration.
 *
 * WHY A DO: on a single Node box, live-sync works via the in-memory
 * `claxedoBus` → SSE (`routes/events.ts`). On Cloudflare Workers there is no
 * shared memory across isolates, so a mutation handled by isolate A cannot
 * reach a client whose SSE stream is held by isolate B. A Durable Object is a
 * single-instance, name-addressable actor: every isolate routes
 * `env.LIVE_SYNC_ROOM.get(idFromName("owner:<id>"|"org:<id>"))` to the SAME
 * instance, which owns all of that owner's held streams. Any isolate POSTs a
 * nudge to that instance and the room fans it to every held connection.
 *
 * The public client remains SSE:
 * The hosted client connects with `fetch()` + a manually-read `ReadableStream`
 * and `Accept: text/event-stream` (see claxedo-app
 * `integrations/claxedo-events.tsx` `connect()` — it is SSE, NOT `EventSource`
 * and NOT a WebSocket, because it must attach a signed `Authorization: Bearer`
 * header). The task requires preserving that client contract with zero client
 * changes, so `connectLiveSyncRoom` opens a private WebSocket to the room and
 * exposes its messages as `text/event-stream`. The room accepts the server end
 * with `state.acceptWebSocket` and stores authorization in the socket
 * attachment, which survives eviction. Heartbeats and reauthorization stay in
 * the outer Worker stream; the room owns no timer or pending streaming fetch.
 */

import { eventVisibleTo } from "./routes/event-visibility"
import type { ClaxedoEvent } from "./bus"
import type { ControlPlaneAuthContext } from "./control-plane/auth"

const DEFAULT_HEARTBEAT_MS = 30_000
const MAX_CONNECTIONS = 256
const SSE_QUEUE_LIMIT = 32
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024
const HEARTBEAT: { type: "heartbeat" } = { type: "heartbeat" }

// The room receives the resolved caller identity from the Worker (a TRUSTED
// internal DO fetch — DOs are unreachable from outside the Worker), so it can
// apply `eventVisibleTo` per held connection without re-verifying the bearer.
const HEADER_MODE = "x-livesync-mode"
const HEADER_SUBJECT = "x-livesync-subject"
const HEADER_ORG = "x-livesync-org"
const HEADER_HEARTBEAT_MS = "x-livesync-heartbeat-ms"

/** Structural type of the CF `DurableObjectState` bits the room touches. */
export type LiveSyncSocket = EventTarget & {
  accept?: () => void
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment?(attachment: LiveSyncSocketAttachment): void
  deserializeAttachment?(): LiveSyncSocketAttachment | undefined
  bufferedAmount?: number
}

export type LiveSyncRoomState = {
  acceptWebSocket?: (socket: LiveSyncSocket) => void
  getWebSockets?: () => LiveSyncSocket[]
}

export type LiveSyncRoomEnv = Record<string, unknown> & {
  createWebSocketPair?: () => { client: LiveSyncSocket; server: LiveSyncSocket }
  upgradeResponse?: (client: LiveSyncSocket) => Response
}

type HeldConnection = {
  id: string
  controller: ReadableStreamDefaultController<Uint8Array>
  auth: ControlPlaneAuthContext
}

type LiveSyncSocketAttachment = {
  auth: ControlPlaneAuthContext
}

/** Build the `eventVisibleTo` auth context from the trusted internal headers. */
export function roomAuthFromHeaders(headers: Headers): ControlPlaneAuthContext {
  const mode = headers.get(HEADER_MODE)
  if (mode !== "signed") {
    return { mode: "unsigned-local", reason: "hosted live-sync room (unsigned-local)" }
  }
  const subject = headers.get(HEADER_SUBJECT) ?? ""
  const orgId = headers.get(HEADER_ORG) ?? undefined
  return {
    mode: "signed",
    token: "",
    user: {
      subject,
      tokenIdentifier: subject,
      issuer: "",
      ...(orgId ? { orgId } : {}),
    },
  }
}

/**
 * Derive the DO room NAME from a resolved auth context. Org-scoped events
 * (document.changed, provision) fan to every member of an org, so an org
 * subscriber joins its ORG room and one POST reaches all members; owner-scoped
 * events (workgraph.changed) are still narrowed to the right subject by the
 * per-connection `eventVisibleTo` filter inside the room. Signed callers with
 * no org, and unsigned-local/loopback, key by subject.
 */
export function liveSyncRoomName(ctx: ControlPlaneAuthContext): string {
  if (ctx.mode === "signed" && ctx.user.orgId) return `org:${ctx.user.orgId}`
  if (ctx.mode === "signed") return `owner:${ctx.user.subject}`
  return "owner:local"
}

/** Serialize the resolved identity into the trusted internal-fetch headers. */
export function liveSyncRoomConnectHeaders(
  ctx: ControlPlaneAuthContext,
  heartbeatMs?: number,
): Record<string, string> {
  const headers: Record<string, string> = { accept: "text/event-stream" }
  if (ctx.mode === "signed") {
    headers[HEADER_MODE] = "signed"
    headers[HEADER_SUBJECT] = ctx.user.subject
    if (ctx.user.orgId) headers[HEADER_ORG] = ctx.user.orgId
  } else {
    headers[HEADER_MODE] = "unsigned-local"
  }
  if (heartbeatMs && Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
    headers[HEADER_HEARTBEAT_MS] = String(Math.floor(heartbeatMs))
  }
  return headers
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const

function liveSyncEvent(input: unknown): ClaxedoEvent | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const row = input as Record<string, unknown>
  if (typeof row.ts !== "number" || !Number.isFinite(row.ts)) return
  if (row.type === "workgraph.changed" && typeof row.ownerUserId === "string" && row.ownerUserId) {
    return row as ClaxedoEvent
  }
  if (
    row.type === "document.changed"
    && typeof row.documentId === "string"
    && typeof row.orgId === "string"
    && typeof row.projectId === "string"
    && (row.version === undefined || typeof row.version === "string")
  ) return row as ClaxedoEvent
  if (
    row.type === "provision"
    && typeof row.workspaceId === "string"
    && (row.orgId === undefined || typeof row.orgId === "string")
    && ["acquiring_sandbox", "cloning", "starting_runtime", "waiting_health", "ready", "error"].includes(String(row.step))
    && (row.message === undefined || typeof row.message === "string")
    && (row.totalMs === undefined || typeof row.totalMs === "number")
  ) return row as ClaxedoEvent
}

function defaultWebSocketPair() {
  const Pair = (globalThis as unknown as {
    WebSocketPair?: new () => Record<number, LiveSyncSocket>
  }).WebSocketPair
  if (!Pair) return
  const pair = new Pair()
  const client = pair[0]
  const server = pair[1]
  if (!client || !server) return
  return { client, server }
}

function defaultUpgradeResponse(client: LiveSyncSocket) {
  return new Response(null, { status: 101, webSocket: client } as ResponseInit)
}

function socketFromResponse(response: Response) {
  return (response as Response & { webSocket?: LiveSyncSocket }).webSocket
}

function sameAuth(left: ControlPlaneAuthContext, right: ControlPlaneAuthContext) {
  if (left.mode !== right.mode) return false
  if (left.mode === "unsigned-local" || right.mode === "unsigned-local") return true
  return left.user.subject === right.user.subject && left.user.orgId === right.user.orgId
}

export class LiveSyncRoom {
  private readonly connections = new Map<string, HeldConnection>()
  private readonly encoder = new TextEncoder()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private heartbeatMs = DEFAULT_HEARTBEAT_MS

  constructor(
    private readonly state: LiveSyncRoomState,
    private readonly env: LiveSyncRoomEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname.endsWith("/nudge")) {
      return this.handleNudge(request)
    }
    if (request.method !== "GET" || !url.pathname.endsWith("/connect")) {
      return Response.json({ error: "live-sync route not found" }, { status: 404 })
    }
    const pair = this.env.createWebSocketPair?.() ?? defaultWebSocketPair()
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && this.state.acceptWebSocket && pair) {
      return this.handleWebSocketConnect(request, pair)
    }
    return this.handleSseConnect(request)
  }

  private handleWebSocketConnect(
    request: Request,
    pair: { client: LiveSyncSocket; server: LiveSyncSocket },
  ) {
    if ((this.state.getWebSockets?.().length ?? 0) >= MAX_CONNECTIONS) {
      return Response.json({ error: "live-sync room connection limit reached" }, { status: 503 })
    }
    this.state.acceptWebSocket!(pair.server)
    pair.server.serializeAttachment?.({ auth: roomAuthFromHeaders(request.headers) })
    return (this.env.upgradeResponse ?? defaultUpgradeResponse)(pair.client)
  }

  /** Node/test fallback when the Durable Object WebSocket API is unavailable. */
  private handleSseConnect(request: Request): Response {
    if (this.connections.size >= MAX_CONNECTIONS) {
      return Response.json({ error: "live-sync room connection limit reached" }, { status: 503 })
    }
    const auth = roomAuthFromHeaders(request.headers)
    const hb = Number(request.headers.get(HEADER_HEARTBEAT_MS))
    if (Number.isFinite(hb) && hb > 0) this.heartbeatMs = hb
    const id = crypto.randomUUID()

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.connections.set(id, { id, controller, auth })
        // Initial hello so proxies flush headers and the client's stream
        // watchdog arms immediately (it only resets on `data:` lines).
        this.write(controller, HEARTBEAT)
        this.ensureHeartbeat()
      },
      cancel: () => {
        this.connections.delete(id)
        this.maybeStopHeartbeat()
      },
    }, { highWaterMark: SSE_QUEUE_LIMIT })

    return new Response(body, { headers: SSE_HEADERS })
  }

  /**
   * Fan a nudge (a `ClaxedoEvent`, typically `{type:"workgraph.changed",...}`)
   * to every held connection the event is visible to. Returns
   * `{ delivered, held }` for the caller's diagnostics.
   */
  private async handleNudge(request: Request): Promise<Response> {
    let input: unknown
    try {
      input = await request.json()
    } catch {
      return Response.json({ error: "invalid nudge body" }, { status: 400 })
    }
    const event = liveSyncEvent(input)
    if (!event) return Response.json({ error: "invalid nudge body" }, { status: 400 })
    let delivered = 0
    for (const connection of [...this.connections.values()]) {
      if (!eventVisibleTo(connection.auth, event)) continue
      if (this.write(connection.controller, event)) {
        delivered += 1
        continue
      }
      this.connections.delete(connection.id)
    }
    const sockets = this.state.getWebSockets?.() ?? []
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment?.()
      if (!attachment || !eventVisibleTo(attachment.auth, event)) continue
      if ((socket.bufferedAmount ?? 0) > MAX_SOCKET_BUFFER_BYTES) {
        socket.close(1013, "live-sync client is too slow")
        continue
      }
      try {
        socket.send(JSON.stringify(event))
        delivered += 1
      } catch {
        socket.close(1011, "live-sync delivery failed")
      }
    }
    return Response.json({ delivered, held: this.connections.size + sockets.length })
  }

  private write(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown): boolean {
    if (controller.desiredSize !== null && controller.desiredSize <= 0) return false
    try {
      controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      return true
    } catch {
      // Controller already closed (client gone before `cancel()` fired). The
      // stale entry is pruned on the next `cancel()`/heartbeat sweep.
      return false
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => {
      for (const connection of [...this.connections.values()]) {
        if (!this.write(connection.controller, HEARTBEAT)) {
          // Prune connections whose controller has closed without a cancel.
          this.connections.delete(connection.id)
        }
      }
      this.maybeStopHeartbeat()
    }, this.heartbeatMs)
    // Never let the heartbeat keep the isolate alive on its own.
    ;(this.heartbeat as { unref?: () => void }).unref?.()
  }

  private maybeStopHeartbeat(): void {
    if (this.connections.size > 0 || this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /** Test/introspection helper: number of currently held connections. */
  get size(): number {
    return this.connections.size + (this.state.getWebSockets?.().length ?? 0)
  }

  webSocketMessage(socket: LiveSyncSocket) {
    socket.close(1008, "live-sync sockets are server-push only")
  }

  webSocketClose(socket: LiveSyncSocket, code: number, reason: string) {
    socket.close(code, reason)
  }

  webSocketError(socket: LiveSyncSocket) {
    socket.close(1011, "live-sync socket error")
  }
}

/** Worker-safe structural type of the `LIVE_SYNC_ROOM` DO namespace binding. */
export interface LiveSyncRoomStub {
  fetch(request: Request): Promise<Response>
}

export interface LiveSyncRoomNamespace {
  idFromName(name: string): unknown
  get(id: unknown): LiveSyncRoomStub
}

/**
 * Route a resolved-auth client connection to that caller's room. Production
 * rooms return a hibernatable WebSocket; this function bridges it back to the
 * browser's existing SSE response and owns heartbeat reauthorization.
 */
export function connectLiveSyncRoom(
  namespace: LiveSyncRoomNamespace,
  ctx: ControlPlaneAuthContext,
  heartbeatMs?: number,
  reauthorize?: () => Promise<ControlPlaneAuthContext>,
): Promise<Response> {
  return namespace
    .get(namespace.idFromName(liveSyncRoomName(ctx)))
    .fetch(
      new Request("https://live-sync-room.internal/connect", {
        method: "GET",
        headers: {
          ...liveSyncRoomConnectHeaders(ctx, heartbeatMs),
          upgrade: "websocket",
          connection: "Upgrade",
        },
      }),
    )
    .then((response) => {
      const socket = socketFromResponse(response)
      if (!socket) return response
      const encoder = new TextEncoder()
      const intervalMs = heartbeatMs && Number.isFinite(heartbeatMs) && heartbeatMs > 0
        ? Math.floor(heartbeatMs)
        : DEFAULT_HEARTBEAT_MS
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined

      const stop = (error?: unknown, settleStream = true) => {
        if (stopped) return
        stopped = true
        if (timer !== undefined) clearTimeout(timer)
        socket.close(error ? 1011 : 1000, error ? "live-sync stream failed" : "live-sync stream closed")
        if (!controller || !settleStream) return
        if (error) controller.error(error)
        else controller.close()
      }
      const write = (data: unknown) => {
        if (!controller || stopped) return false
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          stop(new Error("live-sync client is too slow"))
          return false
        }
        controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`))
        return true
      }
      const heartbeat = async () => {
        if (stopped) return
        try {
          if (reauthorize && !sameAuth(ctx, await reauthorize())) throw new Error("live-sync authorization changed")
          if (!write(HEARTBEAT)) return
          timer = setTimeout(() => void heartbeat(), intervalMs)
          ;(timer as { unref?: () => void }).unref?.()
        } catch (error) {
          stop(error)
        }
      }

      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
          socket.addEventListener("message", (event) => {
            const data = (event as MessageEvent).data
            if (typeof data === "string") write(data)
            else if (data instanceof ArrayBuffer) write(new TextDecoder().decode(data))
          })
          socket.addEventListener("close", () => stop())
          socket.addEventListener("error", () => stop(new Error("live-sync room socket failed")))
          socket.accept?.()
          write(HEARTBEAT)
          timer = setTimeout(() => void heartbeat(), intervalMs)
          ;(timer as { unref?: () => void }).unref?.()
        },
        cancel() {
          stop(undefined, false)
        },
      }, { highWaterMark: SSE_QUEUE_LIMIT })
      return new Response(body, { headers: SSE_HEADERS })
    })
}

/** POST a nudge to the room that owns `roomName`, fanning it to held clients. */
export async function nudgeLiveSyncRoom(
  namespace: LiveSyncRoomNamespace,
  roomName: string,
  event: ClaxedoEvent,
): Promise<{ delivered: number; held: number }> {
  const response = await namespace
    .get(namespace.idFromName(roomName))
    .fetch(
      new Request("https://live-sync-room.internal/nudge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }),
    )
  if (!response.ok) {
    throw new Error(`live-sync-room nudge failed: ${response.status} ${await response.text()}`.trim())
  }
  return (await response.json()) as { delivered: number; held: number }
}
