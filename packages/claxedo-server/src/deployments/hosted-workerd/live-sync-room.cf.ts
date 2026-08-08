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
 * with `state.acceptWebSocket` and stores the subscriber principal in the socket
 * attachment, which survives eviction. Heartbeats and reauthorization stay in
 * the outer Worker stream; the room owns no timer or pending streaming fetch.
 *
 * ## Last-Event-ID replay
 *
 * The room also holds this deployment's SSE retention ring, so the hosted
 * stream is resumable on the same terms as the three local ones
 * (`routes/events.ts`, `routes/opencode-compat-events.ts`,
 * `workspace-runtime/src/routes/runtime-events.ts`). Before this, hosted
 * clients had the resume machinery on the client and nothing to talk to: the
 * bridge wrote no `id:` lines, so claxedo-app's cursor stayed null forever, it
 * never sent `Last-Event-ID`, and every reconnect gap lost whatever was
 * published inside it. Local and hosted diverged on reconnect for the same
 * bundle, which is the divergence this closes.
 *
 * Where the pieces live and why is documented on `LiveSyncRoom.replay` (ring
 * placement, in-memory vs `state.storage`) and `cursorAhead` (what a reset
 * sequence does to a stale cursor). The three invariants the sibling streams
 * established hold here too: `id:` on data frames and none on periodic
 * heartbeats, a bootstrap heartbeat carrying the resume cursor written before
 * anything else, and a cursor-less connection served NOTHING from the ring.
 */

import { createSseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { eventVisibleTo, type EventScopePrincipal } from "../../platform/http/event-visibility"
import { isTerminalClaxedoEvent } from "@claxedo/server-core/platform/http/event-retention"
import type { ClaxedoEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { liveSyncRoomNameForPrincipal, type LiveSyncRoomNamespace } from "../../platform/http/live-sync-publish"
import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"

const DEFAULT_HEARTBEAT_MS = 30_000
/**
 * Held connections one room admits, across BOTH hold mechanisms.
 *
 * Measured 2026-07-30 rather than asserted (see
 * `docs/cf-reliability-scalability-review-2026-07-28.md`, and the
 * harness at `scripts/bench/live-sync-capacity.ts`). The previous 256 was a
 * guess. One room under workerd held 16,000 concurrent bridged connections at a
 * 100% connect rate, fanning an org-wide nudge to all of them with a p99
 * arrival of 417ms; the first failures appeared around 16,300 and were the
 * HARNESS's transport, not the room (the room refused nothing — `capRefused=0`).
 * So 16k is a floor on the room's capability, not its ceiling.
 *
 * 2,000 is deliberately far below that: an 8x margin under the lowest number
 * measured, which keeps org-wide fan-out p99 near 50ms rather than 400ms. It
 * also comfortably clears the 1,000-connection org this work targets, which is
 * what makes sharding unnecessary — see the review doc for that decision.
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
 * Deployment override, read off the Worker env so the cap can be retuned (or
 * driven past its default by the capacity harness) without a code change. Both
 * counters resolve through THIS function — the WS and SSE paths hold
 * connections in different places but share one budget, and a room that
 * admitted the full cap on EACH would hold twice what was measured safe.
 */
function maxConnections(env: LiveSyncRoomEnv): number {
  const raw = env.LIVE_SYNC_MAX_CONNECTIONS
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONNECTIONS
  return Math.min(Math.floor(parsed), MAX_CONNECTIONS_CEILING)
}
const SSE_QUEUE_LIMIT = 32
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024
const HEARTBEAT: { type: "heartbeat" } = { type: "heartbeat" }

// The room receives the resolved caller identity from the Worker (a TRUSTED
// internal DO fetch — DOs are unreachable from outside the Worker), so it can
// apply `eventVisibleTo` per held connection without re-verifying the bearer.
// NAMESPACE: `x-livesync-org` carries the AUTHORITY-INTERNAL org id resolved
// at connect (`authority.resolveOrgId`), matching the namespace events are
// stamped with — NEVER the raw Clerk org claim (see `EventScopePrincipal`).
const HEADER_MODE = "x-livesync-mode"
const HEADER_SUBJECT = "x-livesync-subject"
const HEADER_ORG = "x-livesync-org"
const HEADER_HEARTBEAT_MS = "x-livesync-heartbeat-ms"
/** The client's SSE `Last-Event-ID`, forwarded on the internal connect fetch. */
const HEADER_LAST_EVENT_ID = "x-livesync-last-event-id"
/**
 * Response header on the room's `/connect` reply carrying the cursor this
 * connection resumes from. The bridge cannot compute it: for a CURSOR-LESS
 * client the resume point is the room's own `lastId()`, which only the room
 * knows, and getting it wrong is the difference between "everything from now
 * on" and "re-deliver the whole retained log on the next reconnect".
 */
const HEADER_CURSOR = "x-livesync-cursor"

/**
 * Synthetic frame written in place of a replay when the requested cursor has
 * already fallen out of the room's retention window (or belongs to a sequence
 * this room no longer has — see `cursorAhead`). Deliberately the same shape and
 * `code` as `ClaxedoStreamGapEvent` in `routes/events.ts`: hosted and local
 * serve the SAME route to the SAME claxedo-app bundle, so a consumer that grows
 * a handler must not have to learn two spellings. Declared here rather than
 * imported because `routes/events.ts` pulls the process-local `claxedoBus` and
 * `hono/streaming`, neither of which may enter the Worker bundle.
 */
export type LiveSyncStreamGapEvent = {
  type: "stream.replay-gap"
  code: "claxedo.sse_replay_gap"
  message: string
  severity: "warn"
  lastEventId?: string
  throughId?: string
}

type LiveSyncFrame = ClaxedoEvent | LiveSyncStreamGapEvent

/**
 * Internal DO→bridge wire envelope. The room holds the ring, so the room is the
 * only party that knows a frame's `id:`; the bridge turns SSE bytes. Carrying
 * the id beside the frame keeps the PUBLIC wire unchanged — the bridge still
 * writes the bare event JSON on the `data:` line and adds `id:` as its own
 * line, exactly like the three already-resumable streams.
 */
type LiveSyncWireFrame = { id: string; frame: LiveSyncFrame }

function replayGapEvent(lastEventId?: string, throughId?: string): LiveSyncStreamGapEvent {
  return {
    type: "stream.replay-gap",
    code: "claxedo.sse_replay_gap",
    message: "Claxedo event replay cursor is no longer available; refetch control-plane state.",
    severity: "warn",
    ...(lastEventId ? { lastEventId } : {}),
    ...(throughId ? { throughId } : {}),
  }
}

function numericId(id: string | undefined) {
  if (!id) return 0
  const parsed = Number.parseInt(id, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * True when the presented cursor is numerically AHEAD of everything this room
 * has ever assigned — proof that the sequence it came from is gone.
 *
 * Ids only ever increase within one room instance, so strictly-greater is
 * impossible in normal operation. It happens when the Durable Object was
 * evicted (its in-memory ring, and with it the counter, resets to zero) or when
 * the caller's room NAME changed (an org grant moves a client from
 * `owner:<subject>` to `org:<id>`, whose sequence is unrelated).
 *
 * `SseReplayBuffer` cannot detect this on its own: `hasGap` short-circuits to
 * false whenever `after >= through`, and `replayAfter` filters to the empty
 * set, so a stale-high cursor is served silence — the client keeps a cursor
 * that will never match again and never learns its incremental view is stale.
 * Silence is the one failure mode a replay contract must not have, so the room
 * converts it into the same explicit gap notice a genuine eviction produces.
 */
function cursorAhead(cursor: string | undefined, throughId: string | undefined) {
  return numericId(cursor) > numericId(throughId)
}

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
  upgradeResponse?: (client: LiveSyncSocket, headers?: Record<string, string>) => Response
  /** Optional deployment override for the held-connection cap; see `maxConnections`. */
  LIVE_SYNC_MAX_CONNECTIONS?: string | number
}

type HeldConnection = {
  id: string
  controller: ReadableStreamDefaultController<Uint8Array>
  principal: EventScopePrincipal
}

type LiveSyncSocketAttachment = {
  principal: EventScopePrincipal
}

/**
 * The resolved subscriber a live-sync connection is held for. `auth` is the
 * verified control-plane context (Clerk claims — used only for heartbeat
 * reauthorization comparisons); `orgId` is the AUTHORITY-INTERNAL org id
 * resolved via `authority.resolveOrgId(auth)` at connect time, the identity
 * rooms are named with and `eventVisibleTo` scopes on. Absent `orgId` (no
 * authority composed) degrades to the subject-keyed owner room, where
 * org-scoped events stay invisible fail-closed.
 */
export type LiveSyncSubscriber = {
  auth: ControlPlaneAuthContext
  orgId?: string
}

/** Build the per-connection scope principal from the trusted internal headers. */
export function roomPrincipalFromHeaders(headers: Headers): EventScopePrincipal {
  const mode = headers.get(HEADER_MODE)
  if (mode !== "signed") return { mode: "unsigned-local" }
  const orgId = headers.get(HEADER_ORG) ?? undefined
  return {
    mode: "signed",
    subject: headers.get(HEADER_SUBJECT) ?? "",
    ...(orgId ? { orgId } : {}),
  }
}

/**
 * Derive the DO room NAME from a resolved subscriber. Org-scoped events
 * (document.changed, provision) fan to every member of an org, so a subscriber
 * joins the room of their ACTIVE org — named by the authority-internal org id
 * resolved at connect — and one POST reaches all members; owner-scoped events
 * (workgraph.changed) are still narrowed to the right subject by the
 * per-connection `eventVisibleTo` filter inside the room. Signed callers with
 * no resolved org, and unsigned-local/loopback, key by subject.
 */
export function liveSyncRoomName(subscriber: LiveSyncSubscriber): string {
  if (subscriber.auth.mode !== "signed") return "owner:local"
  return liveSyncRoomNameForPrincipal({
    ownerUserId: subscriber.auth.user.subject,
    orgId: subscriber.orgId,
  })
}

/**
 * The ONE publisher-side room-name derivation, applying the same
 * org-first/owner-fallback policy as `liveSyncRoomName` (which delegates here,
 * so subscriber and publisher cannot drift). A publisher that composes the
 * string by hand (`` `org:${orgId}` ``) silently disagrees with the subscriber
 * whenever its org field is absent or from the wrong namespace, and its events
 * strand in a room nobody is held in.
 *
 * NAMESPACE CONTRACT: room names live in the AUTHORITY-INTERNAL namespace —
 * `orgId` must be the internal org id (Convex `orgs._id`, SQLite `org_id`,
 * i.e. `authority.resolveOrgId` output, which is also what WorkGraph tenancy,
 * runtime-token claims, and document/provision event stamps carry) and
 * `ownerUserId` the Clerk subject, because that is the material
 * `connectLiveSyncRoom` keys the subscriber's room with. Clerk org claims
 * (`org_...`, `ControlPlaneAuthContext.user.orgId`) are a DIFFERENT namespace:
 * passing one as `orgId` names a room no subscriber ever joins.
 *
 * Throws when the material cannot name a real room (absent, empty, or a
 * literal "undefined"/"null" from stringifying a missing field), so a broken
 * publisher fails loudly at the publish site instead of quietly dropping the
 * frame.
 */

/** Serialize the resolved identity into the trusted internal-fetch headers. */
export function liveSyncRoomConnectHeaders(
  subscriber: LiveSyncSubscriber,
  heartbeatMs?: number,
  lastEventId?: string,
): Record<string, string> {
  const headers: Record<string, string> = { accept: "text/event-stream" }
  if (subscriber.auth.mode === "signed") {
    headers[HEADER_MODE] = "signed"
    headers[HEADER_SUBJECT] = subscriber.auth.user.subject
    if (subscriber.orgId) headers[HEADER_ORG] = subscriber.orgId
  } else {
    headers[HEADER_MODE] = "unsigned-local"
  }
  if (heartbeatMs && Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
    headers[HEADER_HEARTBEAT_MS] = String(Math.floor(heartbeatMs))
  }
  // Forwarded verbatim. The bearer is NOT re-verified inside the room, but the
  // cursor is not an authorization input: every replayed frame still clears
  // `eventVisibleTo` against the identity in the headers above, so a forged
  // cursor can only change WHICH of the caller's own frames it receives.
  if (lastEventId) headers[HEADER_LAST_EVENT_ID] = lastEventId
  return headers
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store",
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

function defaultUpgradeResponse(client: LiveSyncSocket, headers?: Record<string, string>) {
  return new Response(null, { status: 101, webSocket: client, ...(headers ? { headers } : {}) } as ResponseInit)
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

  /**
   * The room's SSE retention ring — an INSTANCE field, which is the whole
   * reason replay can exist on the hosted path at all.
   *
   * On a single Node box the equivalent ring is a module singleton fed by the
   * process-global `claxedoBus` (`routes/events.ts`). That shape is not
   * available here: a Cloudflare Worker isolate is ephemeral and there are many
   * of them, so a ring in isolate memory would be filled by whichever isolate
   * happened to handle a mutation and read by a different one — empty exactly
   * when it matters. The Durable Object is the only single-instance,
   * name-addressable place in the hosted deployment: every `nudgeLiveSyncRoom`
   * publisher and every subscriber for a room converge on THIS object, so the
   * ring, the id sequence, and the held connections are all colocated. That is
   * also why the ring is per-ROOM rather than per-process — there is no
   * per-process anything to hang it on.
   *
   * Retention is the shared 256 + 64 the sibling streams use. `liveSyncEvent`
   * admits only `workgraph.changed`, `document.changed`, and `provision`, so
   * this ring holds coalesced doorbells and provision progress and nothing
   * chatty — 256 is far more than the worst client gap (claxedo-app's 45s
   * heartbeat watchdog plus its 2s reconnect floor) can span. The terminal ring
   * still earns its keep: `isTerminalClaxedoEvent` protects the doorbells and
   * the `ready`/`error` provision settlements, whose loss is not self-healing.
   *
   * ## Why in-memory and NOT `state.storage`
   *
   * The namespace is SQLite-backed (wrangler migration v3 declares
   * `new_sqlite_classes`), so durable storage is available and would survive
   * eviction. It is deliberately not used:
   *
   *  - Every nudge would become a storage write on the mutation hot path —
   *    every WorkGraph command, every document mutation — to durably preserve
   *    frames whose entire payload is "something changed".
   *  - The recovery those frames drive is a refetch. A ring that loses its
   *    contents on eviction degrades to a replay-gap notice, and a gap notice
   *    tells the client to refetch, which is what replaying every doorbell in
   *    the ring would have made it do anyway. Durability buys byte-exact replay
   *    of instructions that are already idempotent.
   *  - The window the fix targets is the reconnect gap, and a room that was
   *    just woken by the nudge is still live across it.
   *
   * The cost is a sequence that resets on eviction. That is not silent ON
   * RECONNECT: `cursorAhead` turns a cursor from a lost sequence into the gap
   * notice — but only at connect time. A connection HELD across the reset sees
   * the sequence go backwards with no notice; measured fail-safe both ways
   * (post-reset frames still deliver, and a stale cursor gets the gap notice
   * on its next reconnect) — see scripts/drill/live-sync-post-reset-resume-probe.ts.
   */
  private readonly replay = createSseReplayBuffer<ClaxedoEvent>({ isTerminal: isTerminalClaxedoEvent })

  constructor(
    private readonly state: LiveSyncRoomState,
    private readonly env: LiveSyncRoomEnv,
  ) {}

  /**
   * The cursor a connection resumes from. A CURSOR-LESS connection resumes at
   * `lastId()` — "everything from now on" — so it is served nothing from the
   * ring. That matters even on a stream of doorbells: `provision` frames are
   * progress steps, so re-delivering a retained log to a fresh page would walk
   * a settled workspace back through `cloning` and leave a spinner that nothing
   * will ever settle again.
   */
  private resumeCursor(headers: Headers) {
    return headers.get(HEADER_LAST_EVENT_ID) ?? this.replay.lastId() ?? "0"
  }

  /**
   * What to write to a connection at open time, after its bootstrap frame.
   *
   * The identity filter is applied HERE and in `handleNudge`, and both call the
   * same `eventVisibleTo` with the same principal — the room is shared by
   * every member of an org (`liveSyncRoomName` keys org members to `org:<id>`),
   * so the ring holds several identities' frames and the only thing keeping
   * carol from replaying alice's `workgraph.changed` is that replayed frames
   * traverse the same predicate live frames do.
   *
   * Ids stay the room's SHARED publish-order sequence rather than a
   * per-identity renumbering: a cursor has to mean the same thing on every
   * connection to that room. The knock-ons match `routes/events.ts` — a
   * filtered frame consumes an id without being delivered, so a quiet
   * identity's cursor lags, and `hasGap` is computed over the shared sequence
   * so a busy org can produce a gap notice for an identity that lost nothing.
   * Over-reporting is the only safe direction: the ring cannot know whether an
   * already-evicted frame was visible to the caller.
   */
  private replayFrames(principal: EventScopePrincipal, cursor: string): Array<{ id?: string; frame: LiveSyncFrame }> {
    const throughId = this.replay.lastId()
    if (cursorAhead(cursor, throughId) || this.replay.hasGap(cursor, throughId)) {
      // The notice REPLACES the partial replay — a reader must refetch, not
      // stitch a hole-ridden log into its incremental view. It carries only
      // cursor ids, no tenant data, so it bypasses the identity filter.
      return [{ frame: replayGapEvent(cursor, throughId) }]
    }
    return this.replay
      .replayAfter(cursor, throughId)
      .filter((event) => eventVisibleTo(principal, event.payload))
      .map((event) => ({ id: event.id, frame: event.payload }))
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
    const cursor = this.resumeCursor(request.headers)
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
    const cursor = this.resumeCursor(request.headers)
    const hb = Number(request.headers.get(HEADER_HEARTBEAT_MS))
    if (Number.isFinite(hb) && hb > 0) this.heartbeatMs = hb
    const id = crypto.randomUUID()

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.connections.set(id, { id, controller, principal })
        // Initial hello so proxies flush headers and the client's stream
        // watchdog arms immediately (it only resets on `data:` lines). It
        // carries the cursor this connection resumes from, and is written
        // BEFORE any replayed frame — without it the ring would be dead weight
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
          ? [{ id: undefined, frame: replayGapEvent(cursor, this.replay.lastId()) }]
          : replayed
        for (const entry of frames) {
          if (!this.write(controller, entry.frame, entry.id)) break
        }
        this.ensureHeartbeat()
      },
      cancel: () => {
        this.connections.delete(id)
        this.maybeStopHeartbeat()
      },
    }, { highWaterMark: SSE_QUEUE_LIMIT })

    return new Response(body, { headers: { ...SSE_HEADERS, [HEADER_CURSOR]: cursor } })
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
    // Retain BEFORE fanning out, and once for the whole room. The id minted
    // here is what both the live write below and any later replay carry, so a
    // frame is byte-identical either way and a reconnecting client can tell
    // that it already has it. Retention is unconditional — the frames worth
    // recovering are precisely the ones published while NO connection was
    // attached, so a ring that only filled when someone was listening would be
    // empty exactly when it is needed.
    const { id } = this.replay.push(event)
    let delivered = 0
    for (const connection of [...this.connections.values()]) {
      if (!eventVisibleTo(connection.principal, event)) continue
      if (this.write(connection.controller, event, id)) {
        delivered += 1
        continue
      }
      this.connections.delete(connection.id)
    }
    const sockets = this.state.getWebSockets?.() ?? []
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment?.()
      if (!attachment?.principal || !eventVisibleTo(attachment.principal, event)) continue
      if ((socket.bufferedAmount ?? 0) > MAX_SOCKET_BUFFER_BYTES) {
        socket.close(1013, "live-sync client is too slow")
        continue
      }
      if (this.send(socket, event, id)) delivered += 1
      else socket.close(1011, "live-sync delivery failed")
    }
    return Response.json({ delivered, held: this.connections.size + sockets.length })
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

/**
 * Route a resolved subscriber's client connection to their room. Production
 * rooms return a hibernatable WebSocket; this function bridges it back to the
 * browser's existing SSE response and owns heartbeat reauthorization
 * (comparing fresh Clerk claims against `subscriber.auth` — a claims change
 * closes the stream so the client reconnects and re-resolves its org).
 */
export function connectLiveSyncRoom(
  namespace: LiveSyncRoomNamespace,
  subscriber: LiveSyncSubscriber,
  heartbeatMs?: number,
  reauthorize?: () => Promise<ControlPlaneAuthContext>,
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
       * Unwrap the internal id-carrying envelope back into the PUBLIC wire the
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
        if (parsed && typeof parsed === "object" && "frame" in parsed) {
          const envelope = parsed as LiveSyncWireFrame
          if (typeof envelope.id === "string") return write(envelope.frame, envelope.id)
        }
        return write(raw)
      }
      const heartbeat = async () => {
        if (stopped) return
        try {
          if (reauthorize && !sameAuth(subscriber.auth, await reauthorize())) {
            throw new Error("live-sync authorization changed")
          }
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
            if (typeof data === "string") writeMessage(data)
            else if (data instanceof ArrayBuffer) writeMessage(new TextDecoder().decode(data))
          })
          socket.addEventListener("close", () => stop())
          socket.addEventListener("error", () => stop(new Error("live-sync room socket failed")))
          // The bootstrap frame is written BEFORE `accept()`, not after. The
          // room has already queued this connection's replayed frames on the
          // socket, and accepting is what releases them; writing the cursor
          // first is the only ordering that guarantees a replayed frame can
          // never precede the bootstrap and walk the reader's cursor forward
          // past frames it has not received.
          write(HEARTBEAT, cursor)
          socket.accept?.()
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

// The publisher-side helpers live in platform/ so hosts and domains can ring
// the doorbell without importing a deployment. Re-exported here because this
// module is where the room itself is defined.
export {
  liveSyncRoomNameForPrincipal,
  nudgeLiveSyncRoom,
  type LiveSyncRoomNamespace,
  type LiveSyncRoomStub,
} from "../../platform/http/live-sync-publish"
