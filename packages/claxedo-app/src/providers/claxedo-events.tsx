/**
 * ClaxedoEventsProvider
 *
 * Subscribes to GET /claxedo/events SSE stream from claxedo-server.
 * Provides an event bus for frontend components to receive PTY and agent lifecycle events.
 */

import {
  createContext,
  createSignal,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js"
import { getClaxedoServerUrl } from "../utils/api"

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
  | {
      type: "provision"
      workspaceId: string
      step: "acquiring_sandbox" | "cloning" | "uploading_runtime" | "starting_runtime" | "waiting_health" | "ready" | "error"
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
      handlers.get(type)!.add(handler as unknown as Handler<ClaxedoEventType>)
      return () => {
        handlers.get(type)?.delete(handler as unknown as Handler<ClaxedoEventType>)
      }
    },
    emit(event: ClaxedoEvent) {
      const set = handlers.get(event.type)
      if (!set) return
      for (const handler of set) {
        try {
          handler(event as ClaxedoEventOf<ClaxedoEventType>)
        } catch (err) {
          console.error("[ClaxedoEvents] handler error", err)
        }
      }
    },
  }
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

const RECONNECT_DELAY_MS = 2000
const HEARTBEAT_TIMEOUT_MS = 45000

export function ClaxedoEventsProvider(props: ParentProps) {
  const emitter = createEventEmitter()
  const [connected, setConnected] = createSignal(false)

  let es: EventSource | null = null
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const resetHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    heartbeatTimer = setTimeout(() => {
      // Heartbeat timed out — force reconnect
      es?.close()
      es = null
      setConnected(false)
      scheduleReconnect()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  const connect = () => {
    if (stopped) return
    const url = `${getClaxedoServerUrl()}/api/claxedo/events`
    es = new EventSource(url)

    es.onopen = () => {
      setConnected(true)
      resetHeartbeat()
    }

    es.onmessage = (e) => {
      resetHeartbeat()
      try {
        const event = JSON.parse(e.data) as ClaxedoEvent & { type: string }
        if ((event.type as string) === "heartbeat") return
        emitter.emit(event as ClaxedoEvent)
      } catch {
        // ignore parse errors
      }
    }

    es.onerror = () => {
      es?.close()
      es = null
      setConnected(false)
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
      scheduleReconnect()
    }
  }

  const scheduleReconnect = () => {
    if (stopped) return
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, RECONNECT_DELAY_MS)
  }

  connect()

  onCleanup(() => {
    stopped = true
    es?.close()
    es = null
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
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
