/**
 * ClaxedoEventsProvider — the app's one reader of its two event streams:
 * `cp/events` (a control plane's notices; a signed desktop reads its daemon's
 * and the hosted control plane's) and the `wr/events` of the workspace the
 * route names (that runtime's session frames and control frames). Every
 * frame enters one emitter; consumers subscribe by type or listen to all.
 *
 * One workspace stream, the routed one: a pane of another local workspace
 * left open on the desktop gets that workspace's `pty.*` and
 * `agent.lifecycle` only when the route returns to it (the reconnect
 * reconciles) or from the rail's periodic status read — the daemon's
 * control-plane stream no longer carries every local workspace's frames.
 */

import {
  createContext,
  createEffect,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStreamConnectivity } from "../connection/stream-connectivity"
import { asRecord, readField, readString } from "@/lib/record"
import type { AccountState } from "@/platform/account/account-port"
import type { SessionLifecycleEvent } from "../../features/session/data/session-lifecycle"
import type { DocumentChangedEvent } from "../../features/documents/data/document-changed-event"
import {
  claxedoEventRouteSessionID,
  claxedoEventStreamTargets,
  eventStreamFetch,
  eventStreamFrameAddress,
  type StreamFrameAddress,
  eventStreamTargetKey,
  routeDirectory,
  type ClaxedoEventStreamTarget,
} from "./claxedo-event-targets"
import { markWorkspaceReconnected, markWorkspaceReconnecting } from "../../features/workspaces/data/workspace-connection"
import { sessionInventoryDirectory } from "../../features/session/data/sync/queries"
import { requestSessionHistoryResync } from "../../features/session/store/session-history-resync"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import {
  streamSyncArmedTimer,
  transitionStreamSyncLifecycle,
  type StreamSyncLifecycleEvent,
  type StreamSyncLifecycleState,
} from "../connection/stream-sync-lifecycle"
import { clearStreamSyncLifecycle, reportStreamSyncLifecycle, type StreamSyncStreamId } from "@/platform/runtime/stream-sync-status"
import {
  registerSessionEventStreamLane,
  reportSessionEventStreamClosed,
  reportSessionEventStreamOpen,
  sessionEventScopeWorkspaceAddress,
  type SessionEventStreamLane,
  sessionEventScopeId,
  setSessionEventRouteScope,
} from "@/platform/runtime/session-event-scope"
import { queryClient } from "@/platform/query/query-client"
import { readProjectCatalog } from "@/platform/query/control-plane"
import { queryKeys } from "@/platform/query/keys"
import {
  HEARTBEAT_TIMEOUT_MS,
  failureEscalation,
  reconnectDelayMs,
} from "../providers/claxedo-events-reconnect"
import { applyWorktreeLifecycleEvent } from "@/platform/sync/worktree"
import { errorMessage } from "@/lib/server-errors"
import { accountStreamAvailable } from "@/platform/account/account-stream-fetch"

// ─── Event Types ──────────────────────────────────────────────────────────
//
// The union of everything either stream delivers, each shape kept in sync
// with its producer across the package boundary: the control-plane notices
// with `ControlPlaneEvent` (claxedo-server-core `platform/runtime/lib/bus.ts`),
// the pty/process/agent/session control frames with `WorkspaceRuntimeEvent`
// (workspace-runtime `bus.ts`), and the session frames with the runtime's
// projected presentation events (`ClientPresentationEvent`).

export type PtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
}

type SessionShareChangedEvent = {
  type: "session.share.changed"
  phase: "granted" | "revoked"
  ownerUserId: string
  sessionId: string
  workspaceId: string
  orgId?: string
  ts: number
}

/** A workspace's inventory gained or lost a session in the control plane's projection; the reader re-reads it. */
type SessionInventoryChangedEvent = {
  type: "session.inventory.changed"
  workspaceId: string
  orgId?: string
  ts: number
}

export type ClaxedoEvent =
  | { type: "pty.created"; info: PtyInfo }
  | { type: "pty.updated"; info: PtyInfo }
  | { type: "pty.exited"; id: string; exitCode: number }
  | { type: "pty.deleted"; id: string }
  | {
      type: "pty.stream"
      id: string
      kind: "exit" | "disconnect" | "error" | "command-exit"
      exitCode?: number
      message?: string
    }
  | {
      type: "agent.lifecycle"
      tabId: string
      terminalId?: string
      workspaceId?: string
      provider?: string
      sessionId?: string
      transcriptPath?: string
      refName?: string
      prompt?: string
      lastAssistantMessage?: string
      eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"
      outcome?: "done" | "error" | "cancelled"
    }
  | { type: "process.started"; directory?: string; configId: string; ptyId: string }
  | { type: "process.stopped"; directory?: string; configId: string; exitCode: number }
  | { type: "process.crashed"; directory?: string; configId: string; exitCode: number; restartCount: number; commandExit?: boolean; ptyId?: string }
  | { type: "process.status"; directory?: string; configId: string; status: string }
  | { type: "process.config.changed"; directory?: string; configs: unknown[] }
  | { type: "worktree.ready"; directory: string; name: string; branch: string }
  | { type: "worktree.failed"; directory: string; message: string }
  | SessionLifecycleEvent
  | DocumentChangedEvent
  | SessionShareChangedEvent
  | SessionInventoryChangedEvent
  | ClaxedoDirectoryEvent
  | {
      type: "provision"
      workspaceId: string
      step: "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
      ts: number
    }
  /**
   * A stream's own notice that frames between the reader's cursor and the
   * live position are gone. Raised for a rolled replay ring and for frames
   * shed under a slow consumer alike. A `wr` gap names the workspace whose
   * sessions have to be re-read; a `cp` gap means every notice the control
   * plane could have sent — a worktree landing, a share, a document save —
   * has to be re-read from its source.
   */
  | { type: "stream.replay-gap"; stream: "cp"; transport: "server" | "account" }
  | { type: "stream.replay-gap"; stream: "wr"; workspaceId: string; directory?: string }
  | { type: "subagent.updated"; directory?: string; workspaceId?: string; properties: unknown }
  | { type: "goal.updated"; directory?: string; workspaceId?: string; properties: unknown }
  | { type: "goal.cleared"; directory?: string; workspaceId?: string; properties: unknown }

type ClaxedoDirectoryEventType =
    | "message.updated"
    | "message.part.updated"
    | "message.part.delta"
    | "message.completed"
    | "session.idle"
    | "session.error"
    | "session.status"
    | "session.updated"
    | "session.deleted"
    | "session.agent"
    | "todo.updated"
    | "permission.asked"
    | "permission.replied"
    | "question.asked"
    | "question.replied"
    | "question.rejected"
    | "session.diff"
    | "session.compacted"

export type ClaxedoDirectoryEvent = { [Type in ClaxedoDirectoryEventType]: {
  type: Type
  directory?: string
  /**
   * The workspace the frame was published for: what the frame itself names,
   * else the workspace whose stream delivered it (`stampWorkspace`). The
   * session-title projection keys entries by it as well as by `directory`;
   * a `session.updated` retitle that carries no workspace is written under
   * the directory key only, which the workspace-attributed rail rows never
   * read.
   */
  workspaceId?: string
  properties?: unknown
} }[ClaxedoDirectoryEventType]

type ClaxedoEventType = ClaxedoEvent["type"]
type ClaxedoEventOf<T extends ClaxedoEventType> = Extract<ClaxedoEvent, { type: T }>

type Handler<T extends ClaxedoEventType> = (event: ClaxedoEventOf<T>) => void

// ─── Event Emitter ────────────────────────────────────────────────────────

export function createClaxedoEventEmitter() {
  const handlers = new Map<ClaxedoEventType, Set<Handler<ClaxedoEventType>>>()
  const listeners = new Set<(event: ClaxedoEvent) => void>()

  return {
    listen: (listener: (event: ClaxedoEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    on<T extends ClaxedoEventType>(type: T, handler: Handler<T>) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as-any: handlers are stored in one map and recovered by the discriminant key.
      handlers.get(type)!.add(handler as unknown as Handler<ClaxedoEventType>)
      return () => {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as-any: remove uses the same discriminant-keyed handler registered above.
        handlers.get(type)?.delete(handler as unknown as Handler<ClaxedoEventType>)
      }
    },
    emit(event: ClaxedoEvent) {
      applyWorktreeLifecycleEvent(event)
      for (const listener of listeners) {
        try { listener(event) } catch {}
      }
      const set = handlers.get(event.type)
      if (!set) return
      for (const handler of set) {
        try {
          handler(event as ClaxedoEventOf<ClaxedoEventType>)
        } catch {
        }
      }
    },
  }
}

/**
 * A workspace stream's session frames belong to that workspace: the
 * session-title projection keys by it as well as by directory. A frame that
 * names its own workspace keeps it.
 */
function stampWorkspace(event: ClaxedoEvent, target: ClaxedoEventStreamTarget): ClaxedoEvent {
  if (target.kind !== "wr" || !("properties" in event) || !("directory" in event)) return event
  if ("workspaceId" in event && typeof event.workspaceId === "string" && event.workspaceId) return event
  return { ...event, workspaceId: target.workspaceId }
}

export function isStreamReplayGap(input: unknown) {
  return asRecord(input)?.type === "stream.replay-gap"
}

function isClaxedoEvent(input: unknown): input is ClaxedoEvent | { type: "heartbeat" } {
  return !!input && typeof input === "object" && "type" in input && typeof input.type === "string"
}

/**
 * One stream frame, addressed the way this app addresses that workspace.
 *
 * `address` is the stream's own translation (`eventStreamFrameAddress`): a
 * producer stamps frames with the only path it knows — its own — and for a
 * relay-backed workspace that path names nothing this app can resolve, while
 * every consumer keys on the `workspace:<id>` form the pane, the rail section
 * and the session rows were registered under. It applies to the ENVELOPE's
 * directory and to a payload that carries its own, because both come from the
 * same producer.
 */
export function normalizeClaxedoStreamEvent(
  input: unknown,
  address: StreamFrameAddress = (hostDirectory) => hostDirectory,
): ClaxedoEvent | { type: "heartbeat" } | undefined {
  if (isClaxedoEvent(input)) {
    if (input.type === "heartbeat") return input
    return addressClaxedoEvent(input, address)
  }
  const envelope = asRecord(input)
  const payload = asRecord(envelope?.payload)
  if (!payload) return undefined
  if (payload.type === "heartbeat") return { type: "heartbeat" }
  // The envelope's directory addresses a payload that names none of its own.
  // Stamped on the FRAME, before it is read as a `ClaxedoEvent`: stamping it
  // after meant re-declaring the result to be one, which is false for the arms
  // whose contract has no `directory` at all (`pty.*`, `agent.lifecycle`,
  // `provision`). It also leaves `addressClaxedoEvent` as the single place the
  // address translation is applied, instead of two branches applying it apart.
  const envelopeDirectory = readString(envelope, "directory")
  const framed = readString(payload, "directory") || !envelopeDirectory
    ? payload
    : { ...payload, directory: envelopeDirectory }
  if (!isClaxedoEvent(framed) || framed.type === "heartbeat") return undefined
  return addressClaxedoEvent(framed, address)
}

function addressClaxedoEvent(event: ClaxedoEvent, address: StreamFrameAddress) {
  if (!("directory" in event) || typeof event.directory !== "string" || !event.directory) return event
  return { ...event, directory: address(event.directory) }
}

// ─── Context ──────────────────────────────────────────────────────────────

type ClaxedoEventsContextValue = {
  /** Every frame from every open stream, in arrival order; the GlobalSDK bridge reads this. */
  listen(listener: (event: ClaxedoEvent) => void): () => void
  on<T extends ClaxedoEventType>(type: T, handler: Handler<T>): () => void
  /**
   * ANY stream target is up (`cp` OR the workspace's `wr`). Correct for "is
   * the app talking to anything", wrong as a revalidation edge for either
   * kind's consumers — see `app/connection/stream-connectivity.ts`.
   */
  connected: () => boolean
  /**
   * A control-plane stream is up. They carry `document.changed`,
   * `session.share.changed` and `session.inventory.changed`. Distinct from
   * `connected` on purpose: with a remote workspace open the aggregate never
   * drops to false when only a control plane's stream flaps.
   */
  centralConnected: () => boolean
  /**
   * Counts a control-plane stream's return after a drop the level never
   * showed (a second control plane held it up) — with `centralConnected`, the
   * revalidation edge for the doorbells above, each outage once.
   */
  controlPlaneReconnects: () => number
  /** The routed workspace's stream (`wr`) is up: the one carrying `agent.lifecycle` and `pty.*`; its edge is the agent-status reconciliation's. */
  workspaceConnected: () => boolean
}

const ClaxedoEventsContext = createContext<ClaxedoEventsContextValue>()

export function useClaxedoEvents() {
  const ctx = useContext(ClaxedoEventsContext)
  if (!ctx) throw new Error("useClaxedoEvents must be used inside ClaxedoEventsProvider")
  return ctx
}

export function useClaxedoEventsOptional() {
  return useContext(ClaxedoEventsContext)
}

// ─── Provider ─────────────────────────────────────────────────────────────


// Classify an event-stream connect failure into a human-actionable cause.
// Distinguishes the relay edge (network/CORS) from the Runtime Access Token
// mint (control-plane status) from the relayed runtime response.
function describeEventStreamFailure(error: unknown, target: ClaxedoEventStreamTarget) {
  const message = errorMessage(error)
  const name = error instanceof Error ? error.name : typeof error
  const ctx = target.kind === "cp"
    ? { stream: "cp" as const, transport: target.transport, url: target.url }
    : {
        stream: "wr" as const,
        workspaceId: target.workspaceId,
        ...(target.directory ? { directory: target.directory } : {}),
      }
  // The control-plane mint surfaces as "Workspace connection failed: <status>"
  // (thrown) or, when the relay seam maps a failed connection to a synthetic
  // response, as "events stream failed: 502".
  // The underlying cause may be embedded in the 502 wrapper body, e.g.
  // "events stream failed: 502 (Workspace connection failed: 401)" or
  // "events stream failed: 502 (Failed to fetch)". Match against the whole
  // message so the real root cause wins over the generic 502.
  const mintStatus = /Workspace connection failed: (\d+)/.exec(message)?.[1]
  const httpStatus = /events stream failed: (\d+)/.exec(message)?.[1]
  const isNetwork = (error instanceof TypeError && /fetch/i.test(message)) || /failed to fetch/i.test(message)
  let cause: string
  let hint: string | undefined
  if (mintStatus) {
    cause = `runtime-access-token-mint:${mintStatus}`
    hint = mintStatus === "401" ? "browser auth invalid/expired — re-authenticate"
      : mintStatus === "409" ? "no active host link — run `claxedo up`"
      : mintStatus === "429" ? "connection rate-limited — backing off"
      : "control-plane rejected the connection mint"
  } else if (isNetwork) {
    cause = "network-or-cors"
    hint = "the relay edge request was blocked or unreachable (check the failed /events request in DevTools → Network → Response)"
  } else if (httpStatus === "502") {
    cause = "relay-connection-unreachable"
    hint = "relay could not reach the workspace runtime (host offline, stale Runtime Access Token, or relay edge)"
  } else if (httpStatus) {
    cause = `runtime-response:${httpStatus}`
    hint = "the runtime returned a non-OK status for the event stream"
  } else if (message === "events stream closed") {
    cause = "stream-closed"
    hint = "the stream ended after being open (idle/heartbeat timeout or host drop)"
  } else {
    cause = "unknown"
  }
  return { cause, ...(hint ? { hint } : {}), errorName: name, errorMessage: message.slice(0, 200), ...ctx }
}



async function workspaceStreamDenied(res: Response) {
  const body: unknown = await res.clone().json().catch(() => undefined)
  return readString(readField(body, "error"), "code") === "workspace_event_stream_denied"
}

export function ClaxedoEventsProvider(props: ParentProps<{
  pathname: () => string
  serverUrl: () => string
  accountState: () => AccountState
}>) {
  const emitter = createClaxedoEventEmitter()
  const connectivity = createStreamConnectivity()

  type Connection = { retarget: (target: ClaxedoEventStreamTarget) => void; close: () => void }
  const connections = new Map<string, Connection>()
  let stopped = false

  const emitEvent = (input: string, target: ClaxedoEventStreamTarget) => {
    const address = eventStreamFrameAddress(target)
    try {
      const frame = JSON.parse(input) as unknown
      // The producer's own notice that frames between this reader's cursor and
      // the live position are gone — a rolled replay ring, or frames shed under
      // a slow consumer. It is per-connection, not a bus event, so it has no
      // handler; what it means is that everything this stream feeds has to be
      // read again, and the stream stays open.
      if (isStreamReplayGap(frame)) {
        if (target.kind === "wr") {
          // Addressed the way the panes registered this workspace's sessions:
          // a relay-backed workspace's host path names nothing here.
          const directory = target.directory ? address(target.directory) : undefined
          requestSessionHistoryResync({ reason: "sse-gap", ...(directory ? { directory } : {}) })
          emitter.emit({ type: "stream.replay-gap", stream: "wr", workspaceId: target.workspaceId, ...(directory ? { directory } : {}) })
          return
        }
        emitter.emit({ type: "stream.replay-gap", stream: "cp", transport: target.transport })
        return
      }
      const event = normalizeClaxedoStreamEvent(frame, address)
      if (!event || event.type === "heartbeat") return
      emitter.emit(stampWorkspace(event, target))
    } catch {
      // ignore parse errors
    }
  }

  if (import.meta.env.DEV && typeof window !== "undefined") {
    const target = window as typeof window & {
      __claxedoEmitTestEvent?: (event: ClaxedoEvent | { type: "heartbeat" }) => void
    }
    const emitTestEvent = (event: ClaxedoEvent | { type: "heartbeat" }) => {
      if (!isClaxedoEvent(event) || event.type === "heartbeat") return
      emitter.emit(event)
    }
    target.__claxedoEmitTestEvent = emitTestEvent
    onCleanup(() => {
      if (target.__claxedoEmitTestEvent === emitTestEvent) delete target.__claxedoEmitTestEvent
    })
  }

  const connectTarget = (initialTarget: ClaxedoEventStreamTarget): Connection => {
    let target = initialTarget
    const state = {
      // A `wr` target opens unscoped. A runtime that refuses the reader at
      // workspace level (a share grantee) is asked again for the routed
      // session, and the target stays session-scoped from then on. Refused
      // on a route that names no session, the target waits for one.
      scope: "workspace" as "workspace" | "session" | "refused",
      abort: null as AbortController | null,
      heartbeatTimer: null as ReturnType<typeof setTimeout> | null,
      reconnectTimer: null as ReturnType<typeof setTimeout> | null,
      failures: 0,
      lifecycle: "idle" as StreamSyncLifecycleState,
      // SSE `Last-Event-ID` cursor for THIS target's stream. See the parsing
      // loop below for why an untracked cursor is a correctness bug, not just
      // a bandwidth one.
      lastEventId: null as string | null,
    }

    // Keyed by workspaceId so `SessionConnectionLine` can read the stream that
    // carries that session's events.
    const lane: SessionEventStreamLane | undefined = target.kind === "wr" ? `wr:${target.workspaceId}` : undefined
    const streamId: StreamSyncStreamId = lane ?? (target.kind === "cp" && target.transport === "account" ? "cp:account" : "cp")
    // The workspace stream carries a session's live frames, so the scope owner
    // has to know whether it is open and for which session. Opened unscoped it
    // carries every session; opened for a grantee it carries one.
    const releaseLane = lane ? registerSessionEventStreamLane(lane) : undefined
    const reportLaneOpen = () => {
      if (!lane || target.kind !== "wr") return
      reportSessionEventStreamOpen(lane, state.scope === "session" ? target.sessionID : undefined)
    }
    const reportLaneClosed = () => {
      if (lane) reportSessionEventStreamClosed(lane)
    }

    // Per-kind accounting: this stream's bit feeds the aggregate `connected()`
    // and, for a `cp` target, `centralConnected()` and `controlPlaneReconnects()`.
    const setStreamConnected = connectivity.track(target.kind)

    const stepLifecycle = (event: StreamSyncLifecycleEvent) => {
      state.lifecycle = transitionStreamSyncLifecycle(state.lifecycle, event) ?? state.lifecycle
      reportStreamSyncLifecycle(streamId, state.lifecycle)
      return state.lifecycle
    }

    const beginConnect = () => {
      if (state.lifecycle === "idle") stepLifecycle("connect")
      if (state.lifecycle === "reconnect-scheduled") stepLifecycle("retry")
    }

    // Timer-exclusivity invariant from the connection lifecycle machine: entering
    // the reconnect state reconciles timers to `streamSyncArmedTimer(...)`, so the
    // heartbeat and reconnect timers can never both be armed.
    // Set by `close()`: a target removed from the reconciled set never
    // reconnects, whatever its transport does with the aborted body.
    let closed = false
    const scheduleReconnect = () => {
      if (stopped || closed) return
      if (streamSyncArmedTimer(state.lifecycle) !== "reconnect") {
        if (state.lifecycle === "idle") stepLifecycle("connect")
        if (state.lifecycle === "connecting" || state.lifecycle === "live") stepLifecycle("error")
      }
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer)
        state.heartbeatTimer = null
      }
      if (state.reconnectTimer) return
      const delay = reconnectDelayMs(state.failures, fastSessionSwitchAnyQuietDelay())
      state.failures += 1
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null
        connect()
      }, delay)
    }

    const resetHeartbeat = () => {
      if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
      state.heartbeatTimer = setTimeout(() => {
        stepLifecycle("timeout")
        state.heartbeatTimer = null
        state.abort?.abort()
        state.abort = null
        setStreamConnected(false)
        reportLaneClosed()
        scheduleReconnect()
      }, HEARTBEAT_TIMEOUT_MS)
    }

    const connect = () => {
      if (stopped || closed || state.scope === "refused") return
      beginConnect()
      const quietDelay = fastSessionSwitchAnyQuietDelay()
      if (quietDelay > 0) {
        stepLifecycle("error")
        if (!state.reconnectTimer) {
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null
            connect()
          }, quietDelay)
        }
        return
      }
      state.abort = new AbortController()
      // NOTE: no `bypassFetchThrottle` here — the `Accept: text/event-stream`
      // header already exempts SSE from the throttle, and the bypass MARKER
      // header leaks onto the wire, failing the relay's CORS preflight
      // (x-fetch-bypass-throttle is not in its allow-list) — which killed
      // every workspace event stream in the browser and flapped the
      // connection authority ready→reconnecting.
      const headers = new Headers({ Accept: "text/event-stream" })
      if (state.lastEventId) headers.set("Last-Event-ID", state.lastEventId)
      void eventStreamFetch(target, {
        headers,
        signal: state.abort.signal,
      }, { scope: state.scope === "session" ? "session" : "workspace" }).then(async (res) => {
        // Only the runtime's own refusal of the unscoped arm narrows the
        // stream: a 403 minted elsewhere on the path (the relay while its
        // host is away, the token mint) is an outage to retry, not a share
        // grantee's cue to read one session.
        if (res.status === 403 && target.kind === "wr" && state.scope === "workspace" && await workspaceStreamDenied(res)) {
          state.abort = null
          if (target.sessionID) {
            state.scope = "session"
            // The session's ring is its own numbering; the workspace ring's
            // cursor names nothing in it and would read as a gap.
            state.lastEventId = null
            connect()
            return
          }
          // A grantee on a route with no session — the workspace's draft
          // route — has nothing the runtime will serve. Not an outage: no
          // retry, no escalation, no "Reconnecting…"; the next navigation
          // that names a session reopens.
          state.scope = "refused"
          stepLifecycle("stop")
          clearStreamSyncLifecycle(streamId)
          state.lifecycle = "idle"
          setStreamConnected(false)
          reportLaneClosed()
          return
        }
        if (!res.ok || !res.body) {
          // The relay seam maps a failed relay connection to a synthetic 502
          // whose BODY carries the underlying error (e.g. the real
          // "Workspace connection failed: 401" or a network message). Read it
          // so the diagnostic surfaces the true root cause, not just "502".
          const detail = (await res.text().catch(() => "")).trim()
          throw new Error(`events stream failed: ${res.status}${detail ? ` (${detail.slice(0, 200)})` : ""}`)
        }
        stepLifecycle("open")
        setStreamConnected(true)
        reportLaneOpen()
        // A cursor-less open is served nothing from the ring: whatever a
        // session did between a pane's history read and this moment is behind
        // the stream, not on it. The workspace's controllers re-read once, now
        // that the stream is live, so a reply that landed in that window is
        // read rather than lost. A resumed open recovers by cursor instead.
        if (target.kind === "wr" && !state.lastEventId) {
          const directory = target.directory ? eventStreamFrameAddress(target)(target.directory) : undefined
          requestSessionHistoryResync({ reason: "stream-open", ...(directory ? { directory } : {}) })
        }
        state.failures = 0
        // Bridge stream health → the single WorkspaceConnection authority: a
        // recovered workspace stream nudges `reconnecting → ready` (no-op unless
        // the authority had flipped to reconnecting). Readiness is owned by the
        // authority; this stream does not infer it.
        if (target.kind === "wr") markWorkspaceReconnected(target.workspaceId)
        resetHeartbeat()
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          if (stopped) break
          const next = await reader.read()
          if (stopped) break
          if (next.done) break
          buffer += decoder.decode(next.value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            const lines = chunk.split("\n").map((line) => line.trim())
            // Advance this stream's `Last-Event-ID` cursor. A cursor means
            // "the last frame I applied": a reconnect resumes behind it, and
            // a cursor-less reconnect is resumed at the ring's head instead,
            // so nothing already applied — an answered `question.asked`, a
            // settled `permission.asked` — comes down a second time. Periodic
            // heartbeats carry no `id:` and never move it.
            const id = lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim()
            if (id) state.lastEventId = id
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice("data:".length).trim())
              .join("\n")
            if (!data) continue
            stepLifecycle("heartbeat")
            resetHeartbeat()
            emitEvent(data, target)
          }
        }
        throw new Error("events stream closed")
      }).catch((error) => {
        if (stopped || closed) return
        if (error instanceof DOMException && error.name === "AbortError") return
        // Diagnostic: the per-workspace event stream silently failing is the #1
        // thing that makes the app look dead (no live updates / no streamed
        // agent response). Log a precise, greppable classification so an
        // interactive session can read the ROOT cause from the console without
        // guessing: a network/CORS failure ("Failed to fetch") points at the
        // relay edge; a `connection failed: <status>` points at the Runtime
        // Access Token mint (401 = bad/expired browser auth, 409 = no active
        // host, 429 = rate limit); an `events stream failed: <status>` is the
        // relayed runtime response itself. The first few consecutive failures
        // are the tunnel settling (transient 502s / mint races) and self-heal
        // via backoff, so keep them on a quiet `console.debug` path; only a
        // SUSTAINED failure run escalates to `console.error`. `state.failures`
        // is the count of PRIOR failures (incremented later in
        // `scheduleReconnect`), so it is 0 on the first failure.
        const diagnostic = describeEventStreamFailure(error, target)
        const escalation = failureEscalation(state.failures)
        if (escalation === "escalate") {
          // Escalate exactly once when the failure run first becomes sustained,
          // so a real outage surfaces a single greppable diagnostic instead of
          // re-spamming on every backoff tick. (`state.failures` resets to 0 on
          // a successful open, so a later run can escalate again.)
          console.error("[claxedo-events] stream failed", JSON.stringify(diagnostic))
          // A SUSTAINED workspace-stream outage nudges the authority
          // `ready → reconnecting` (queries park, NO teardown) — the first-N
          // transient failures stay quiet (BUG-8) and do NOT flip readiness.
          if (target.kind === "wr") markWorkspaceReconnecting(target.workspaceId)
        } else if (escalation === "quiet") {
          console.debug("[claxedo-events] stream failed (transient, retrying)", diagnostic)
        }
        state.abort = null
        setStreamConnected(false)
        reportLaneClosed()
        stepLifecycle("error")
        if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
        scheduleReconnect()
      })
    }

    connect()

    const close = () => {
      closed = true
      state.abort?.abort()
      state.abort = null
      setStreamConnected.release()
      releaseLane?.()
      stepLifecycle("stop")
      // Deliberate teardown (target removed / provider cleanup) must not leave
      // a frozen `{stopped, everLive: true}` snapshot behind: nothing will
      // reconnect a stopped stream, and any session mapping to this streamId
      // later would read the stale snapshot as a permanent reconnect. Clearing
      // also resets `everLive`, so re-adding the same target (switching back
      // to an old session) counts as ordinary startup again — the quiet-window
      // `error → reconnect-scheduled` hop during a fast session switch no
      // longer flashes "Reconnecting…" over a healthy stream.
      clearStreamSyncLifecycle(streamId)
      if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    }

    // The routed session is the stream's FALLBACK scope, not its identity: a
    // workspace-wide stream carries every session and survives a navigation
    // with its cursor. Only a stream the runtime narrowed to one session has
    // to be reopened when that session changes — cursor-less, since the new
    // session's scope is a different ring.
    const retarget = (next: ClaxedoEventStreamTarget) => {
      const previous = target
      target = next
      if (next.kind !== "wr" || previous.kind !== "wr") return
      if (state.scope === "refused") {
        if (!next.sessionID) return
        state.scope = "session"
        state.lastEventId = null
        connect()
        return
      }
      if (state.scope !== "session" || previous.sessionID === next.sessionID) return
      state.abort?.abort()
      state.abort = null
      state.lastEventId = null
      state.scope = "workspace"
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer)
        state.reconnectTimer = null
      }
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer)
        state.heartbeatTimer = null
      }
      setStreamConnected(false)
      reportLaneClosed()
      if (state.lifecycle === "connecting" || state.lifecycle === "live") stepLifecycle("error")
      connect()
    }

    return { retarget, close }
  }

  const reconcileTargets = () => {
    const accountState = props.accountState()
    const accountSigned = accountState.status === "signed"
    const routedSession = claxedoEventRouteSessionID(props.pathname())
    const targets = claxedoEventStreamTargets({
      serverUrl: props.serverUrl(),
      // A bare `/s/<id>` route names no workspace; the pane that opened the
      // session says which, and until it has, the session's inventory row does.
      directory: routeDirectory(props.pathname())
        ?? sessionEventScopeWorkspaceAddress(routedSession)
        ?? (routedSession ? sessionInventoryDirectory(props.serverUrl(), routedSession) : undefined),
      // `session-event-scope` owns which session the scoped stream must carry;
      // the route is its standing input, not a second decider.
      sessionID: sessionEventScopeId(),
      projects: readProjectCatalog(props.serverUrl()),
      accountSigned,
      accountStream: accountStreamAvailable(accountState),
    })
    const next = new Map(targets.map((target) => [eventStreamTargetKey(target), target]))
    for (const [key, connection] of connections) {
      if (next.has(key)) continue
      connection.close()
      connections.delete(key)
    }
    for (const [key, target] of next) {
      const existing = connections.get(key)
      if (existing) {
        existing.retarget(target)
        continue
      }
      connections.set(key, connectTarget(target))
    }
  }

  // This provider is the app's reader of the shell route for event purposes, so
  // it is what publishes the route's session to `session-event-scope`; the
  // composer, which mounts underneath and cannot see this one's closures, reads
  // the same answer to know which stream must be open before its first prompt.
  const publishRouteScope = () => setSessionEventRouteScope(claxedoEventRouteSessionID(props.pathname()))
  publishRouteScope()
  createEffect(publishRouteScope)

  // Route identity and project/workspace identity resolve independently. A
  // client-side navigation can supply the former after boot, while the project
  // query can supply the latter later still; either transition may make a new
  // workspace stream target available.
  reconcileTargets()
  createEffect(reconcileTargets)
  const unsubscribeQueryCache = queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey
    const watched = [queryKeys.controlPlane.projects(props.serverUrl()), queryKeys.shell.sessionInventory(props.serverUrl())]
    if (!watched.some((expected) => key.length === expected.length && expected.every((part, index) => key[index] === part))) return
    reconcileTargets()
  })

  onCleanup(() => {
    stopped = true
    unsubscribeQueryCache()
    connections.forEach((connection) => connection.close())
    connections.clear()
  })

  const value: ClaxedoEventsContextValue = {
    on: emitter.on.bind(emitter),
    listen: emitter.listen,
    connected: connectivity.connected,
    centralConnected: connectivity.centralConnected,
    controlPlaneReconnects: connectivity.controlPlaneReconnects,
    workspaceConnected: connectivity.workspaceConnected,
  }

  return (
    <ClaxedoEventsContext.Provider value={value}>
      {props.children}
    </ClaxedoEventsContext.Provider>
  )
}
