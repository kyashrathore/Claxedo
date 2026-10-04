/**
 * `LiveSyncRoom` — the per-owner Durable Object that holds hibernatable
 * WebSocket connections and can be rung from any Worker isolate. The public
 * Worker route bridges that internal socket to the browser's signed SSE
 * contract, so the Durable Object can park without a client migration.
 *
 * Why a Durable Object: on a single Node box, live-sync works via the
 * in-memory `controlBus` → SSE (the local daemon's `shell/events.ts`). On Cloudflare Workers
 * there is no shared memory across isolates, so a mutation handled by isolate
 * A cannot reach a client whose SSE stream is held by isolate B. A Durable
 * Object is a single-instance, name-addressable actor: every isolate routes
 * `env.LIVE_SYNC_ROOM.get(idFromName("owner:<id>"|"org:<id>"))` to the same
 * instance, which owns all of that owner's held streams. Any isolate posts a
 * nudge to that instance and the room fans it to every held connection.
 *
 * The public client remains SSE:
 * The hosted client connects with `fetch()` + a manually-read `ReadableStream`
 * and `Accept: text/event-stream` (claxedo-app's `openStream`: it is SSE, not `EventSource`
 * and not a WebSocket, because it must attach a signed `Authorization: Bearer`
 * header). The task requires preserving that client contract with zero client
 * changes, so `connectLiveSyncRoom` opens a private WebSocket to the room and
 * exposes its messages as `text/event-stream`. The room accepts the server end
 * with `state.acceptWebSocket` and stores the subscriber principal in the socket
 * attachment, which survives eviction. Heartbeats and reauthorization stay in
 * the outer Worker stream; the room owns no timer or pending streaming fetch.
 * `live-sync-client.cf.ts` owns that SSE bridge; `live-sync-protocol.ts` owns
 * its shared identity headers and socket contract.
 *
 * ## Last-Event-ID replay
 *
 * The room also holds this deployment's SSE retention ring, so the hosted
 * `cp/events` is resumable on the same terms as the local daemon's
 * (`claxedo-local-server/src/shell/events.ts`) and a workspace runtime's
 * `wr/events` (`session-core/src/routes/events.ts`). One client bundle
 * reads all three, and its resume machinery is only as good as the `id:`
 * lines it is fed: a bridge that writes none leaves the client's cursor null,
 * so it never sends `Last-Event-ID` and every reconnect gap loses whatever
 * was published inside it.
 *
 * Where the pieces live and why is documented on `LiveSyncRoom.replay` (ring
 * placement, in-memory vs `state.storage`) and `cursorAhead` (what a reset
 * sequence does to a stale cursor). The three invariants the sibling streams
 * share hold here too: `id:` on data frames and none on periodic heartbeats,
 * a bootstrap heartbeat carrying the resume cursor written before anything
 * else, and a cursor-less connection served nothing from the ring.
 */

import {
  HEADER_CURSOR, HEADER_HEARTBEAT_MS, HEADER_LAST_EVENT_ID,
  HEARTBEAT, SSE_HEADERS, SSE_QUEUE_LIMIT, roomPrincipalFromHeaders,
  type LiveSyncSocket,
} from "./live-sync-protocol"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-runtime-contract"
import { createSseReplayBuffer } from "@claxedo/helpers/sse"
import { eventVisibleTo, type EventScopePrincipal } from "@claxedo/server-core/platform/http/event-visibility"
import { isRetainedControlPlaneEvent, supersededControlPlaneEventKey } from "@claxedo/server-core/platform/http/event-retention"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { liveSyncEvents } from "./live-sync-admission"
import { cursorAhead, replayGapEvent, type LiveSyncStreamGapEvent } from "./live-sync-replay-gap"

/**
 * Held connections one room admits, across both hold mechanisms.
 *
 * Under workerd (miniflare, clients in-process) one room held 4,000
 * connections and fanned an org-scoped nudge to all of them in 100 ms (p99
 * 90 ms); at 2,000 the fan-out took 48 ms (p99 44 ms). Half the held figure
 * keeps org-wide fan-out latency low and comfortably clears the org sizes
 * this work targets, which is what makes sharding unnecessary.
 *
 * Room work per nudge is one attachment read plus an `eventVisibleTo` filter
 * per held connection, so cost is linear in this number with a very small
 * constant. The reason to keep a cap at all is that the fan-out loop is
 * synchronous: it is a bound on how long one room can monopolise its own
 * single-threaded turn, not a bound on socket memory.
 */
export const DEFAULT_MAX_CONNECTIONS = 2_000
/**
 * Hard ceiling on the deployment override below. Cloudflare's documented limit
 * is ~32k hibernatable sockets per Durable Object; leaving real headroom under
 * it means a misconfigured override degrades fan-out latency instead of hitting
 * a runtime limit whose failure mode we have never measured.
 */
const MAX_CONNECTIONS_CEILING = 16_000
/**
 * Deployment override, read off the Worker env so the cap can be retuned
 * without a code change. Both counters resolve through this function — the WS
 * and SSE paths hold connections in different places but share one budget, and
 * a room that admitted the full cap on each would hold twice what was measured
 * safe.
 */
function maxConnections(env: LiveSyncRoomEnv): number {
  const raw = env.LIVE_SYNC_MAX_CONNECTIONS
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONNECTIONS
  return Math.min(Math.floor(parsed), MAX_CONNECTIONS_CEILING)
}
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024

type LiveSyncFrame = ControlPlaneEvent | LiveSyncStreamGapEvent

/**
 * Internal DO→bridge wire envelope. The room holds the ring, so the room is the
 * only party that knows a frame's `id:`; the bridge turns SSE bytes. Carrying
 * the id beside the frame keeps the public wire unchanged — the bridge still
 * writes the bare event JSON on the `data:` line and adds `id:` as its own
 * line, exactly like the three already-resumable streams.
 */
type LiveSyncWireFrame = { id: string; frame: LiveSyncFrame }

export type LiveSyncRoomState = {
  acceptWebSocket?: (socket: LiveSyncSocket) => void
  getWebSockets?: () => LiveSyncSocket[]
}

export type LiveSyncRoomEnv = Record<string, unknown> & {
  createWebSocketPair?: () => { client: LiveSyncSocket; server: LiveSyncSocket }
  upgradeResponse?: (client: LiveSyncSocket, headers?: Record<string, string>) => Response
  /** Optional deployment override for the held-connection cap; see `maxConnections`. */
  LIVE_SYNC_MAX_CONNECTIONS?: string | number
}

type HeldConnection = {
  id: string
  controller: ReadableStreamDefaultController<Uint8Array>
  principal: EventScopePrincipal
}

function isConstructor(value: unknown): value is new () => unknown {
  return typeof value === "function"
}

function isLiveSyncSocket(value: unknown): value is LiveSyncSocket {
  return value instanceof EventTarget && "send" in value && typeof value.send === "function" && "close" in value && typeof value.close === "function"
}

/**
 * `WebSocketPair` is a workerd runtime global, and this module is also built
 * and unit-tested outside a Worker isolate. It is looked up on `globalThis` so
 * an absent global is `undefined` rather than a `ReferenceError`, and the pair
 * it constructs is checked for the socket shape rather than asserted, because
 * `@claxedo/workspace-relay` already declares the same global for its own
 * socket model and a second ambient declaration collides with it.
 */
function defaultWebSocketPair() {
  const Pair: unknown = Reflect.get(globalThis, "WebSocketPair")
  if (!isConstructor(Pair)) return undefined
  const pair = asRecord(new Pair())
  const client = pair?.[0]
  const server = pair?.[1]
  if (!isLiveSyncSocket(client) || !isLiveSyncSocket(server)) return undefined
  return { client, server }
}

function defaultUpgradeResponse(client: LiveSyncSocket, headers?: Record<string, string>) {
  return new Response(null, { status: 101, webSocket: client, ...(headers ? { headers } : {}) } as ResponseInit)
}

function replayPrincipalKey(principal: EventScopePrincipal) {
  if (principal.mode === "unsigned-local") return "local"
  return `signed:${principal.orgId ?? ""}:${principal.subject}`
}

export class LiveSyncRoom {
  private readonly connections = new Map<string, HeldConnection>()
  private readonly encoder = new TextEncoder()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private heartbeatMs = EVENT_STREAM_HEARTBEAT_MS

  /**
   * The room's SSE retention ring — an INSTANCE field, which is the whole
   * reason replay can exist on the hosted path at all.
   *
   * On a single Node box the equivalent ring is a module singleton fed by the
   * process-global `controlBus` (the local daemon's `shell/events.ts`). That shape is not
   * available here: a Cloudflare Worker isolate is ephemeral and there are many
   * of them, so a ring in isolate memory would be filled by whichever isolate
   * happened to handle a mutation and read by a different one — empty exactly
   * when it matters. The Durable Object is the only single-instance,
   * name-addressable place in the hosted deployment: every `nudgeLiveSyncRoom`
   * publisher and every subscriber for a room converge on this object, so the
   * ring, the id sequence, and the held connections are all colocated. That is
   * also why the ring is per-room rather than per-process — there is no
   * per-process anything to hang it on.
   *
   * Retention is the shared 256 + 64 the sibling streams use. `liveSyncEvent`
   * admits share doorbells, held in the terminal reserve, and status and
   * reader notices, held in the main ring only, so neither can evict a
   * doorbell; a replay sends only the latest of each kind per session. One
   * reader's notices fill its own ring at a few per turn plus one seen write
   * per open or shown turn end, far fewer than 256 across the worst client gap
   * (the app's 40 s stall timeout plus a reconnect backoff capped at 15 s); a
   * longer gap becomes a replay-gap notice and a list re-read.
   *
   * ## Why in-memory and not `state.storage`
   *
   * The namespace is SQLite-backed (wrangler migration v3 declares
   * `new_sqlite_classes`), so durable storage is available and would survive
   * eviction. It is deliberately not used:
   *
   *  - Every nudge would become a storage write on the mutation hot path —
   *    every share change — to durably preserve
   *    frames whose entire payload is "something changed".
   *  - The recovery those frames drive is a refetch. A ring that loses its
   *    contents on eviction degrades to a replay-gap notice, and a gap notice
   *    tells the client to refetch, which is what replaying every doorbell in
   *    the ring would have made it do anyway. Durability buys byte-exact replay
   *    of instructions that are already idempotent.
   *  - The window the fix targets is the reconnect gap, and a room that was
   *    just woken by the nudge is still live across it.
   *
   * The cost is a sequence that resets on eviction. `cursorAhead` runs only at
   * connect time, so a connection held across the reset sees ids go backwards
   * with no notice. That stays safe: frames published after the reset still
   * reach the held connection, and when it next reconnects with its cursor
   * from the lost sequence, `cursorAhead` turns that cursor into the gap
   * notice.
   */
  private readonly retained = createSseReplayBuffer<ControlPlaneEvent>({ isTerminal: isRetainedControlPlaneEvent })
  private readonly replays = new Map<string, {
    replay: ReturnType<typeof createSseReplayBuffer<ControlPlaneEvent>>
    principal: EventScopePrincipal
  }>()
  /** A released principal's cursor, and how many frames visible to it the room retained since. */
  private readonly replayTombstones = new Map<string, {
    sequence: number
    retainedCursor?: string
    principal: EventScopePrincipal
    visibleSince: number
  }>()

  constructor(
    private readonly state: LiveSyncRoomState,
    private readonly env: LiveSyncRoomEnv,
  ) {}

  /**
   * The cursor a connection resumes from. A cursor-less connection resumes at
   * `lastId()` — "everything from now on" — so it is served nothing from the
   * ring: a fresh page reads current state and needs no doorbell from before
   * it opened.
   */
  private replayFor(principal: EventScopePrincipal) {
    const key = replayPrincipalKey(principal)
    const existing = this.replays.get(key)
    if (existing) return existing.replay
    const tombstone = this.replayTombstones.get(key)
    this.replayTombstones.delete(key)
    const seed = this.retained.replayAfter(tombstone?.retainedCursor).filter((event) => eventVisibleTo(principal, event.payload))
    // Fewer seeds than the frames counted for this principal since its release
    // means the room's ring evicted some it never got. Skipping one id turns
    // that loss into a replay gap at the principal's own cursor.
    const lost = tombstone !== undefined && seed.length < tombstone.visibleSince
    const replay = createSseReplayBuffer<ControlPlaneEvent>({
      isTerminal: isRetainedControlPlaneEvent,
      supersedes: supersededControlPlaneEventKey,
      ...(tombstone ? { initialSequence: tombstone.sequence + (lost ? 1 : 0) } : {}),
    })
    for (const event of seed) replay.push(event.payload)
    this.replays.set(key, { replay, principal })
    return replay
  }

  private releaseReplay(principal: EventScopePrincipal, closingSocket?: LiveSyncSocket) {
    const key = replayPrincipalKey(principal)
    if ([...this.connections.values()].some((connection) => replayPrincipalKey(connection.principal) === key)) return
    if ((this.state.getWebSockets?.() ?? []).some((socket) => {
      if (socket === closingSocket) return false
      const attachment = socket.deserializeAttachment?.()
      return attachment?.principal && replayPrincipalKey(attachment.principal) === key
    })) return
    const scope = this.replays.get(key)
    if (!scope) return
    const retainedCursor = this.retained.lastId()
    this.replayTombstones.delete(key)
    this.replayTombstones.set(key, {
      sequence: Number(scope.replay.lastId() ?? "0"),
      ...(retainedCursor ? { retainedCursor } : {}),
      principal: scope.principal,
      visibleSince: 0,
    })
    while (this.replayTombstones.size > 256) this.replayTombstones.delete(this.replayTombstones.keys().next().value!)
    this.replays.delete(key)
  }

  private resumeCursor(headers: Headers, principal: EventScopePrincipal) {
    return headers.get(HEADER_LAST_EVENT_ID) ?? this.replayFor(principal).lastId() ?? "0"
  }

  /**
   * What to write to a connection at open time, after its bootstrap frame.
   *
   * The identity filter is applied when populating the principal's replay ring,
   * here during replay drain, and in `handleNudge` for live writes. All three
   * call the same `eventVisibleTo` with the same principal. The room is shared
   * by every member of an org, but cursor ids are minted only after a frame is
   * visible to that principal, so another member's traffic cannot create holes
   * or false replay-gap notices in this connection's sequence.
   */
  private replayFrames(principal: EventScopePrincipal, cursor: string): Array<{ id?: string; frame: LiveSyncFrame }> {
    const replay = this.replayFor(principal)
    const throughId = replay.lastId()
    if (cursorAhead(cursor, throughId) || replay.hasGap(cursor, throughId)) {
      // The notice replaces the partial replay — a reader must refetch, not
      // stitch a hole-ridden log into its incremental view. It carries only
      // cursor ids, no tenant data, so it bypasses the identity filter.
      return [{ frame: replayGapEvent(cursor, throughId) }]
    }
    return replay
      .replayAfter(cursor, throughId)
      .filter((event) => eventVisibleTo(principal, event.payload))
      .map((event) => ({
        id: event.id,
        frame: event.payload.type === "session.status.changed" ? { ...event.payload, replayed: true as const } : event.payload,
      }))
  }

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
    if (this.size >= maxConnections(this.env)) {
      return Response.json({ error: "live-sync room connection limit reached" }, { status: 503 })
    }
    const principal = roomPrincipalFromHeaders(request.headers)
    const cursor = this.resumeCursor(request.headers, principal)
    this.state.acceptWebSocket!(pair.server)
    pair.server.serializeAttachment?.({ principal })
    // Replayed frames are pushed onto the socket before this response is even
    // returned, so they are in flight before the bridge accepts the client end
    // and can never interleave ahead of the bootstrap frame the bridge writes
    // first. Ordering is what makes the cursor safe: a frame that overtook the
    // bootstrap would walk the reader's cursor past events it has not seen.
    //
    // No `bufferedAmount` guard here, unlike the nudge path: a full replay is
    // bounded by the ring at 256 + 64 doorbell-sized frames, which stays well
    // under MAX_SOCKET_BUFFER_BYTES even for a client that never reads. One
    // that stays stalled is shed by that guard on the next nudge anyway.
    for (const replayed of this.replayFrames(principal, cursor)) {
      if (!this.send(pair.server, replayed.frame, replayed.id)) break
    }
    return (this.env.upgradeResponse ?? defaultUpgradeResponse)(pair.client, { [HEADER_CURSOR]: cursor })
  }

  /** Node/test fallback when the Durable Object WebSocket API is unavailable. */
  private handleSseConnect(request: Request): Response {
    if (this.size >= maxConnections(this.env)) {
      return Response.json({ error: "live-sync room connection limit reached" }, { status: 503 })
    }
    const principal = roomPrincipalFromHeaders(request.headers)
    const cursor = this.resumeCursor(request.headers, principal)
    const hb = Number(request.headers.get(HEADER_HEARTBEAT_MS))
    if (Number.isFinite(hb) && hb > 0) this.heartbeatMs = hb
    const id = crypto.randomUUID()

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.connections.set(id, { id, controller, principal })
        // Initial hello so proxies flush headers and the client's stream
        // watchdog arms immediately (it only resets on `data:` lines). It
        // carries the cursor this connection resumes from, and is written
        // before any replayed frame — without it the ring would be dead weight
        // for the gap that matters most, because a reader only learns a cursor
        // by receiving a frame, so a reader that drops before its first frame
        // would reconnect cursor-less and never address the ring at all.
        this.write(controller, HEARTBEAT, cursor)
        // Unlike the socket path, this queue is bounded at SSE_QUEUE_LIMIT and
        // `write` starts refusing once it fills. Stopping mid-replay would hand
        // the reader a hole-ridden log, which is the precise thing the gap
        // notice exists to prevent, so a replay that cannot fit becomes the
        // notice rather than a silent truncation.
        const replayed = this.replayFrames(principal, cursor)
        const frames = replayed.length > SSE_QUEUE_LIMIT - 1
          ? [{ id: undefined, frame: replayGapEvent(cursor, this.replayFor(principal).lastId()) }]
          : replayed
        for (const entry of frames) {
          if (!this.write(controller, entry.frame, entry.id)) break
        }
        this.ensureHeartbeat()
      },
      cancel: () => {
        this.connections.delete(id)
        this.releaseReplay(principal)
        this.maybeStopHeartbeat()
      },
    }, { highWaterMark: SSE_QUEUE_LIMIT })

    return new Response(body, { headers: { ...SSE_HEADERS, [HEADER_CURSOR]: cursor } })
  }

  /**
   * Fan a nudge (one `ControlPlaneEvent` `liveSyncEvents` admits, or a batch
   * of them) to every held connection each event is visible to. Returns
   * `{ delivered, held }` for the caller's diagnostics.
   */
  private async handleNudge(request: Request): Promise<Response> {
    let input: unknown
    try {
      input = await request.json()
    } catch {
      return Response.json({ error: "invalid nudge body" }, { status: 400 })
    }
    const events = liveSyncEvents(input)
    if (!events) return Response.json({ error: "invalid nudge body" }, { status: 400 })
    const delivered = events.reduce((count, event) => count + this.fanOut(event), 0)
    return Response.json({ delivered, held: this.connections.size + (this.state.getWebSockets?.() ?? []).length })
  }

  private fanOut(event: ControlPlaneEvent): number {
    // Retain before fanning out, and once for the whole room, so a principal
    // first seen after this nudge can seed its filtered ring. Each known
    // principal then mints its own compact id after `eventVisibleTo`; that same
    // id is used for the live write and later replay. Retention is unconditional
    // because the frames worth recovering are precisely those published while
    // no connection was attached.
    this.retained.push(event)
    for (const tombstone of this.replayTombstones.values()) {
      if (eventVisibleTo(tombstone.principal, event)) tombstone.visibleSince += 1
    }
    const deliveries = new Map<string, { visible: boolean; id?: string }>()
    for (const scope of this.replays.values()) {
      const visible = eventVisibleTo(scope.principal, event)
      if (visible) scope.replay.push(event)
      deliveries.set(replayPrincipalKey(scope.principal), {
        visible,
        ...(visible ? { id: scope.replay.idFor(event) } : {}),
      })
    }
    const deliveryFor = (principal: EventScopePrincipal) => {
      const key = replayPrincipalKey(principal)
      const existing = deliveries.get(key)
      if (existing) return existing
      const visible = eventVisibleTo(principal, event)
      const replay = this.replayFor(principal)
      const delivery = { visible, ...(visible ? { id: replay.idFor(event) } : {}) }
      deliveries.set(key, delivery)
      return delivery
    }
    let delivered = 0
    const disconnected = new Map<string, EventScopePrincipal>()
    for (const connection of Array.from(this.connections.values())) {
      const delivery = deliveryFor(connection.principal)
      if (!delivery.visible) continue
      if (this.write(connection.controller, event, delivery.id)) {
        delivered += 1
        continue
      }
      this.connections.delete(connection.id)
      disconnected.set(replayPrincipalKey(connection.principal), connection.principal)
    }
    for (const principal of disconnected.values()) this.releaseReplay(principal)
    const sockets = this.state.getWebSockets?.() ?? []
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment?.()
      if (!attachment?.principal) continue
      const delivery = deliveryFor(attachment.principal)
      if (!delivery.visible) continue
      if ((socket.bufferedAmount ?? 0) > MAX_SOCKET_BUFFER_BYTES) {
        socket.close(1013, "live-sync client is too slow")
        continue
      }
      if (this.send(socket, event, delivery.id)) delivered += 1
      else socket.close(1011, "live-sync delivery failed")
    }
    return delivered
  }

  /** Push one frame onto the internal socket in the id-carrying envelope. */
  private send(socket: LiveSyncSocket, frame: LiveSyncFrame, id?: string): boolean {
    try {
      socket.send(JSON.stringify(id ? { id, frame } satisfies LiveSyncWireFrame : frame))
      return true
    } catch {
      return false
    }
  }

  private write(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown, id?: string): boolean {
    if (controller.desiredSize !== null && controller.desiredSize <= 0) return false
    try {
      // `id:` rides only on frames that advance the cursor. Periodic heartbeats
      // deliberately carry none, so one shed from a saturated queue is
      // redelivered on the next reconnect rather than silently skipped over.
      controller.enqueue(this.encoder.encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`))
      return true
    } catch {
      // Controller already closed (client gone before `cancel()` fired). The
      // stale entry is pruned on the next `cancel()`/heartbeat sweep.
      return false
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== undefined) return undefined
    this.heartbeat = setInterval(() => {
      for (const connection of Array.from(this.connections.values())) {
        if (!this.write(connection.controller, HEARTBEAT)) {
          // Prune connections whose controller has closed without a cancel.
          this.connections.delete(connection.id)
          this.releaseReplay(connection.principal)
        }
      }
      this.maybeStopHeartbeat()
    }, this.heartbeatMs)
    // Never let the heartbeat keep the isolate alive on its own.
    ;(this.heartbeat as { unref?: () => void }).unref?.()
  }

  private maybeStopHeartbeat(): void {
    if (this.connections.size > 0 || this.heartbeat === undefined) return undefined
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /** Test/introspection helper: number of currently held connections. */
  get size(): number {
    return this.connections.size + (this.state.getWebSockets?.().length ?? 0)
  }

  /** Test/introspection helper: active replay scopes and bounded reconnect cursors. */
  get replayScopeCount(): number {
    return this.replays.size
  }

  get replayTombstoneCount(): number {
    return this.replayTombstones.size
  }

  webSocketMessage(socket: LiveSyncSocket) {
    socket.close(1008, "live-sync sockets are server-push only")
  }

  webSocketClose(socket: LiveSyncSocket, code: number, reason: string) {
    const principal = socket.deserializeAttachment?.()?.principal
    // An abnormal disconnect has no close frame to acknowledge; 1006 cannot be sent.
    if (code !== 1006) socket.close(code, reason)
    if (principal) this.releaseReplay(principal, socket)
  }

  webSocketError(socket: LiveSyncSocket) {
    const principal = socket.deserializeAttachment?.()?.principal
    socket.close(1011, "live-sync socket error")
    if (principal) this.releaseReplay(principal, socket)
  }
}
