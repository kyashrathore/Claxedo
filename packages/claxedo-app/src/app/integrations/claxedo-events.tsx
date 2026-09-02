/**
 * ClaxedoEventsProvider
 *
 * Subscribes to the Claxedo SSE stream from claxedo-server.
 * Provides an event bus for frontend components to receive PTY and agent lifecycle events.
 */

import {
  createContext,
  createEffect,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStreamConnectivity } from "../connection/stream-connectivity"
import type { AccountState } from "@/platform/account/account-port"
import type { SessionLifecycleEvent } from "../../features/session/data/session-lifecycle"
import type { WorkgraphChangedEvent } from "../../features/workgraph/workgraph-changed-event"
import type { DocumentChangedEvent } from "../../features/documents/data/document-changed-event"
import {
  claxedoEventRouteSessionID,
  claxedoEventStreamTargets,
  eventStreamFetch,
  eventStreamFrameAddress,
  eventStreamTargetKey,
  routeDirectory,
  type ClaxedoEventStreamTarget,
} from "./claxedo-event-targets"
import { markWorkspaceReconnected, markWorkspaceReconnecting, workspaceSessionAuthority } from "../../features/workspaces/data/workspace-connection"
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

// ─── Event Types (must match claxedo-server-core/src/platform/runtime/lib/bus.ts) ─────────────

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
    }
  | { type: "process.started"; directory?: string; configId: string; ptyId: string }
  | { type: "process.stopped"; directory?: string; configId: string; exitCode: number }
  | { type: "process.crashed"; directory?: string; configId: string; exitCode: number; restartCount: number; commandExit?: boolean; ptyId?: string }
  | { type: "process.status"; directory?: string; configId: string; status: string }
  | { type: "process.config.changed"; directory?: string; configs: unknown[] }
  | { type: "worktree.ready"; directory: string; name: string; branch: string }
  | { type: "worktree.failed"; directory: string; message: string }
  | SessionLifecycleEvent
  | WorkgraphChangedEvent
  | DocumentChangedEvent
  | SessionShareChangedEvent
  | ClaxedoDirectoryEvent
  | {
      type: "provision"
      workspaceId: string
      step: "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
      ts: number
    }

export type ClaxedoDirectoryEvent = {
  type:
    | "message.updated"
    | "message.part.updated"
    | "message.part.delta"
    | "message.completed"
    | "session.idle"
    | "session.error"
    | "session.status"
    | "session.updated"
    | "session.agent"
    | "todo.updated"
    | "permission.asked"
    | "permission.replied"
    | "question.asked"
    | "question.replied"
    | "question.rejected"
    | "session.diff"
    | "session.compacted"
  directory?: string
  /**
   * The workspace the frame was published for. Workspace-runtime's bridge
   * stamps it on every workspace-stream frame (alongside `directory`), and the
   * session-title projection keys entries by workspaceId as well as directory —
   * dropping it left a `session.updated` retitle written only under the
   * directory key while workspace-attributed rail rows kept reading the stale
   * canonical under the workspace key (see event-ingress's
   * `applyClaxedoDirectoryEventToSync`).
   */
  workspaceId?: string
  properties?: unknown
}

type ClaxedoEventType = ClaxedoEvent["type"]
type ClaxedoEventOf<T extends ClaxedoEventType> = Extract<ClaxedoEvent, { type: T }>

type Handler<T extends ClaxedoEventType> = (event: ClaxedoEventOf<T>) => void

// ─── Event Emitter ────────────────────────────────────────────────────────

function createEventEmitter() {
  const handlers = new Map<ClaxedoEventType, Set<Handler<ClaxedoEventType>>>()

  return {
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
  address: (directory: string) => string = (directory) => directory,
): ClaxedoEvent | { type: "heartbeat" } | undefined {
  if (isClaxedoEvent(input)) {
    if (input.type === "heartbeat") return input
    return addressClaxedoEvent(input, address)
  }
  const envelope = input && typeof input === "object" && !Array.isArray(input)
    ? input as { directory?: unknown; payload?: unknown }
    : undefined
  const payload = envelope?.payload
  if (!isClaxedoEvent(payload)) return
  if (payload.type === "heartbeat") return payload
  const addressed = addressClaxedoEvent(payload, address)
  if ("directory" in addressed && typeof addressed.directory === "string" && addressed.directory) return addressed
  const directory = typeof envelope?.directory === "string" && envelope.directory ? envelope.directory : undefined
  if (!directory) return addressed
  return { ...addressed, directory: address(directory) } as ClaxedoEvent
}

function addressClaxedoEvent(event: ClaxedoEvent, address: (directory: string) => string) {
  if (!("directory" in event) || typeof event.directory !== "string" || !event.directory) return event
  return { ...event, directory: address(event.directory) } as ClaxedoEvent
}

// ─── Context ──────────────────────────────────────────────────────────────

type ClaxedoEventsContextValue = {
  on<T extends ClaxedoEventType>(type: T, handler: Handler<T>): () => void
  /**
   * ANY stream target is up (central OR any workspace relay stream). Correct for
   * "is the app talking to anything", WRONG as a revalidation edge for a
   * central-bus doorbell — see `centralConnected` and the rationale in
   * `app/connection/stream-connectivity.ts`.
   */
  connected: () => boolean
  /**
   * The CENTRAL control-plane stream is up. This is the stream that carries
   * `workgraph.changed` / `document.changed` / `session.lifecycle` /
   * `session.share.changed`, so its
   * `false → true` edge is the revalidation trigger for every consumer of those
   * doorbells. Distinct from `connected` on purpose: with a remote workspace
   * open the aggregate never drops to false when only the central stream flaps.
   */
  centralConnected: () => boolean
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
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : typeof error
  const ctx = target.kind === "central"
    ? { stream: "central" as const, url: target.url }
    : {
        stream: "workspace" as const,
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



export function ClaxedoEventsProvider(props: ParentProps<{
  pathname: () => string
  serverUrl: () => string
  accountState: () => AccountState
}>) {
  const emitter = createEventEmitter()
  const connectivity = createStreamConnectivity()

  const connections = new Map<string, () => void>()
  let stopped = false

  const emitEvent = (input: string, address: (directory: string) => string) => {
    try {
      const event = normalizeClaxedoStreamEvent(JSON.parse(input) as unknown, address)
      if (!event || event.type === "heartbeat") return
      emitter.emit(event)
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

  const connectTarget = (target: ClaxedoEventStreamTarget, accountState: AccountState) => {
    const frameAddress = eventStreamFrameAddress(target)
    const state = {
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

    // The workspace stream is one of the two lanes that carry a session's live
    // frames, so the scope owner has to know whether it is open and for which
    // session. A LOCAL workspace's stream is workspace-wide (`target.sessionID`
    // is absent), which the owner reads as "carries every session".
    const releaseLane = target.kind === "workspace"
      ? registerSessionEventStreamLane("workspace-bus")
      : undefined
    const reportLaneOpen = () => {
      if (target.kind !== "workspace") return
      reportSessionEventStreamOpen("workspace-bus", target.sessionID)
    }
    const reportLaneClosed = () => {
      if (target.kind !== "workspace") return
      reportSessionEventStreamClosed("workspace-bus")
    }

    // Per-kind accounting: this stream's bit feeds BOTH the aggregate
    // `connected()` and, for the central target, `centralConnected()` — the edge
    // the doorbell consumers revalidate on.
    const setStreamConnected = connectivity.track(target.kind)

    // Stable per-target key for the reactive projection (T7): the shared
    // control-plane stream is `"central"`; a signed workspace's own stream is
    // keyed by its workspaceId so `SessionConnectionLine` can read the stream
    // that actually carries that session's events.
    const streamId: StreamSyncStreamId = target.kind === "central" ? "central" : `workspace:${target.workspaceId}`

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
    const scheduleReconnect = () => {
      if (stopped) return
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
      if (stopped) return
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
      // Resume from this target's cursor instead of re-reading its log from the
      // start. Matches the two global-sdk stream loops, which already resume
      // (`provider.tsx` — `sseJsonStream`'s `onEventId` + `Last-Event-ID`).
      if (state.lastEventId) headers.set("Last-Event-ID", state.lastEventId)
      void eventStreamFetch(target, {
        headers,
        signal: state.abort.signal,
      }, { accountState }).then(async (res) => {
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
        state.failures = 0
        // Bridge stream health → the single WorkspaceConnection authority: a
        // recovered workspace stream nudges `reconnecting → ready` (no-op unless
        // the authority had flipped to reconnecting). Readiness is OWNED by the
        // authority — this stream no longer independently infers "workspace up".
        if (target.kind === "workspace") markWorkspaceReconnected(target.workspaceId)
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
            // Advance this stream's `Last-Event-ID` cursor. This is a
            // CORRECTNESS requirement, not an optimization: `emitEvent` →
            // `normalizeClaxedoStreamEvent` unwraps `{directory, payload}`
            // frames, so this reader applies directory events (permission /
            // question / message) to the shell caches. Both the workspace
            // runtime (`workspace-runtime/src/routes/events.ts`) and the e2e
            // mock serve a CURSOR-LESS connection the full retained log, so
            // without a cursor every reconnect re-applied the entire backlog —
            // re-upserting `question.asked`/`permission.asked` for requests the
            // user had already answered and resurrecting their docks.
            // Short-window replay frames intentionally carry no `id:`, so they
            // do not advance the cursor and keep being redelivered.
            const id = lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim()
            if (id) state.lastEventId = id
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice("data:".length).trim())
              .join("\n")
            if (!data) continue
            stepLifecycle("heartbeat")
            resetHeartbeat()
            emitEvent(data, frameAddress)
          }
        }
        throw new Error("events stream closed")
      }).catch((error) => {
        if (stopped) return
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
          if (target.kind === "workspace") markWorkspaceReconnecting(target.workspaceId)
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

    return () => {
      state.abort?.abort()
      state.abort = null
      setStreamConnected(false)
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
  }

  const reconcileTargets = () => {
    const accountState = props.accountState()
    const accountSigned = accountState.status === "signed"
    const targets = claxedoEventStreamTargets({
      serverUrl: props.serverUrl(),
      directory: routeDirectory(props.pathname()),
      // `session-event-scope` owns which session the scoped stream must carry;
      // the route is its standing input, not a second decider.
      sessionID: sessionEventScopeId(),
      // …and the minted connection owns whether a scoped stream is the only
      // kind this workspace's runtime serves.
      sessionAuthority: workspaceSessionAuthority,
      projects: readProjectCatalog(props.serverUrl()),
      accountSigned,
    })
    const next = new Map(targets.map((target) => [eventStreamTargetKey(target, { accountSigned }), target]))
    for (const [key, cleanup] of connections) {
      if (next.has(key)) continue
      cleanup()
      connections.delete(key)
    }
    for (const [key, target] of next) {
      if (connections.has(key)) continue
      connections.set(key, connectTarget(target, accountState))
    }
  }

  // This provider is the app's reader of the shell route for event purposes, so
  // it is what publishes the route's session to `session-event-scope`. Both
  // lanes then read one answer: this provider's workspace bus below, and the
  // global-sdk provider's runtime-events stream, which mounts underneath and
  // cannot see this one's closures.
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
    const expected = queryKeys.controlPlane.projects(props.serverUrl())
    if (event.query.queryKey.length !== expected.length) return
    if (event.query.queryKey[0] !== expected[0]) return
    if (event.query.queryKey[1] !== expected[1]) return
    if (event.query.queryKey[2] !== expected[2]) return
    reconcileTargets()
  })

  onCleanup(() => {
    stopped = true
    unsubscribeQueryCache()
    connections.forEach((cleanup) => cleanup())
    connections.clear()
  })

  const value: ClaxedoEventsContextValue = {
    on: emitter.on.bind(emitter),
    connected: connectivity.connected,
    centralConnected: connectivity.centralConnected,
  }

  return (
    <ClaxedoEventsContext.Provider value={value}>
      {props.children}
    </ClaxedoEventsContext.Provider>
  )
}
