/**
 * ClaxedoEventsProvider
 *
 * Subscribes to the Claxedo SSE stream from claxedo-server.
 * Provides an event bus for frontend components to receive PTY and agent lifecycle events.
 */

import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js"
import { signedWorkspaceFromProjects } from "../agent-runtime/signed-workspace"
import { authFetch, getClaxedoServerUrl } from "@/shared/data/api"
import type { SessionLifecycleEvent } from "../shared/data/session-lifecycle"
import { shellRouteWorkspaceKeyFromPathname } from "../shell/identity/route"
import { sessionWorkspaceRuntimeRef } from "../shell/workspace/session-workspace-key"
import { markWorkspaceReconnected, markWorkspaceReconnecting } from "../shell/workspace/workspace-connection"
import { fastSessionSwitchAnyQuietDelay } from "../session/store/fast-session-switch"
import {
  streamSyncArmedTimer,
  transitionStreamSyncLifecycle,
  type StreamSyncLifecycleEvent,
  type StreamSyncLifecycleState,
} from "../shell/connection/stream-sync-lifecycle"
import { queryClient } from "../shared/query/query-client"
import { queryKeys } from "../shared/query/keys"
import { createTransport } from "../shell/data/transport/transport"
import { centralTransportForServer } from "@/shell/data/transport/transport"
import {
  HEARTBEAT_TIMEOUT_MS,
  failureEscalation,
  reconnectDelayMs,
} from "./claxedo-events-reconnect"

// ─── Event Types (must match claxedo-server/src/bus.ts) ───────────────────

export type PtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
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
  | {
      type: "provision"
      workspaceId: string
      step: "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
      ts: number
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

// ─── Context ──────────────────────────────────────────────────────────────

type ClaxedoEventsContextValue = {
  on<T extends ClaxedoEventType>(type: T, handler: Handler<T>): () => void
  connected: () => boolean
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

type ProjectCache = Parameters<typeof signedWorkspaceFromProjects>[0]

// The central GLOBAL event stream is fetched directly (signed control-plane
// auth). The per-workspace stream is a runtime-owned long-lived GET that lives
// behind the workspace's relay connection and is reached with the Runtime
// Access Token — exactly like provider/file/PTY reads. Targets are therefore
// discriminated so the events provider can pick the right transport: the
// central stream uses `authFetch`, the workspace stream uses the transport
// seam so loopback workspace streams stay on the local proxy while remote
// workspace streams open through the relay.
export type ClaxedoEventStreamTarget =
  | { kind: "central"; url: URL }
  | { kind: "workspace"; serverUrl: string; workspaceId: string; directory?: string }

export function claxedoEventStreamTargets(input: {
  serverUrl?: string
  directory?: string
  projects?: ProjectCache
}): ClaxedoEventStreamTarget[] {
  const serverUrl = input.serverUrl ?? getClaxedoServerUrl()
  const central: ClaxedoEventStreamTarget = {
    kind: "central",
    url: new URL("/api/wr/events", serverUrl),
  }
  const routeWorkspaceId = input.directory ? sessionWorkspaceRuntimeRef({ directory: input.directory })?.workspaceId : undefined
  const workspaceId = routeWorkspaceId
    ? routeWorkspaceId
    : signedWorkspaceFromProjects(input.projects ?? [], input.directory)?.workspaceId

  if (!workspaceId) return [central]
  return [
    central,
    {
      kind: "workspace",
      serverUrl,
      workspaceId,
      ...(input.directory ? { directory: input.directory } : {}),
    },
  ]
}

// Resolves the fetch + request URL for a target. The workspace stream streams
// from the relay (`relayUrl/workspaces/:id/api/wr/events`) with the RAT in
// `Authorization: Bearer`; the central stream is fetched directly. Both return a
// `Response` whose body the provider reads incrementally (the relay seam does
// NOT buffer GET responses).
export const CLAXEDO_EVENTS_RELAY_PATH = "/api/wr/events"

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

export function eventStreamFetch(
  target: ClaxedoEventStreamTarget,
  init: RequestInit,
  overrides?: { request?: typeof fetch; relayRequest?: typeof fetch },
) {
  if (target.kind === "central") {
    return (overrides?.request ?? authFetch)(target.url, init)
  }
  const serverTransport = centralTransportForServer(target.serverUrl)
  const request = overrides?.request ?? authFetch
  return createTransport({
    placement: {
      workspaceId: target.workspaceId,
      hosting: "workspace",
      transport: serverTransport === "loopback" ? "loopback" : "workspace-relay",
    },
    serverUrl: target.serverUrl,
    directory: target.directory,
    request,
    ...(overrides?.relayRequest ? { relayRequest: overrides.relayRequest } : {}),
  }).fetch(CLAXEDO_EVENTS_RELAY_PATH, init)
}

function initialRouteDirectory() {
  if (typeof window === "undefined") return
  const configured = (window as typeof window & {
    __OPENCODE__?: { activeDirectory?: string }
  }).__OPENCODE__?.activeDirectory
  if (configured) return configured
  return shellRouteWorkspaceKeyFromPathname(window.location.pathname)
}

export function ClaxedoEventsProvider(props: ParentProps) {
  const emitter = createEventEmitter()
  const [connected, setConnected] = createSignal(false)

  const cleanups = new Set<() => void>()
  let connectedStreams = 0
  let stopped = false

  const emitEvent = (input: string) => {
    try {
      const event = JSON.parse(input) as unknown
      if (!isClaxedoEvent(event) || event.type === "heartbeat") return
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

  const connectTarget = (target: ClaxedoEventStreamTarget) => {
    const state = {
      abort: null as AbortController | null,
      heartbeatTimer: null as ReturnType<typeof setTimeout> | null,
      reconnectTimer: null as ReturnType<typeof setTimeout> | null,
      connected: false,
      failures: 0,
      lifecycle: "idle" as StreamSyncLifecycleState,
    }

    const setStreamConnected = (value: boolean) => {
      if (state.connected === value) return
      state.connected = value
      connectedStreams += value ? 1 : -1
      setConnected(connectedStreams > 0)
    }

    const stepLifecycle = (event: StreamSyncLifecycleEvent) => {
      state.lifecycle = transitionStreamSyncLifecycle(state.lifecycle, event) ?? state.lifecycle
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
      void eventStreamFetch(target, {
        headers: { Accept: "text/event-stream" },
        signal: state.abort.signal,
      }).then(async (res) => {
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
            const data = chunk.split("\n")
              .map((line) => line.trim())
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice("data:".length).trim())
              .join("\n")
            if (!data) continue
            stepLifecycle("heartbeat")
            resetHeartbeat()
            emitEvent(data)
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
          console.error("[claxedo-events] stream failed", diagnostic)
          // A SUSTAINED workspace-stream outage nudges the authority
          // `ready → reconnecting` (queries park, NO teardown) — the first-N
          // transient failures stay quiet (BUG-8) and do NOT flip readiness.
          if (target.kind === "workspace") markWorkspaceReconnecting(target.workspaceId)
        } else if (escalation === "quiet") {
          console.debug("[claxedo-events] stream failed (transient, retrying)", diagnostic)
        }
        state.abort = null
        setStreamConnected(false)
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
      stepLifecycle("stop")
      if (state.heartbeatTimer) clearTimeout(state.heartbeatTimer)
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    }
  }

  for (const target of claxedoEventStreamTargets({
    directory: initialRouteDirectory(),
    projects: queryClient.getQueryData<ProjectCache>(queryKeys.controlPlane.projects(getClaxedoServerUrl())) ?? [],
  })) {
    cleanups.add(connectTarget(target))
  }

  onCleanup(() => {
    stopped = true
    cleanups.forEach((cleanup) => cleanup())
    cleanups.clear()
  })

  const value: ClaxedoEventsContextValue = {
    on: emitter.on.bind(emitter),
    connected,
  }

  return (
    <ClaxedoEventsContext.Provider value={value}>
      {props.children}
    </ClaxedoEventsContext.Provider>
  )
}
