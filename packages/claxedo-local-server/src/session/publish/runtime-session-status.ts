import type { SessionRowStatus, SessionRowStatusKind } from "@claxedo/server-core/session/navigation-list"
import { record, raw } from "../../platform/json"
import { readRuntimeSessionActivity, runtimeStatusKind, type RuntimeStatusRead } from "../runtime-activity"
import { parseBackgroundWork, type BackgroundWork } from "@claxedo/agent-runtime-contract"

type ObservedRuntime = {
  workspace: { id: string }
  frames: { subscribe(listener: (frame: unknown) => void): () => void }
}

export type RuntimeSessionStatusOptions = {
  /** The embedded runtime registry: replays what is mounted, then reports every change. */
  observe: (listener: (runtime: ObservedRuntime, phase: "mounted" | "retired" | "disposed") => void) => () => void
  read: RuntimeStatusRead
  now?: () => number
  onChange: (workspaceId: string, sessionId: string) => void
}

export type RuntimeSessionStatus = {
  /** The last status this process saw for the session; idle, as of now, for one it never saw. */
  current: (workspaceId: string, sessionId: string) => SessionRowStatus | undefined
  /**
   * What the workspace's runtime holds right now, read in process, keyed by
   * session. Empty for a workspace with no runtime up. What it reads replaces
   * what the frames had accumulated, so later frames build on the truth.
   */
  snapshot: (workspaceId: string) => Promise<Map<string, SessionRowStatus> | undefined>
  stop: () => void
}

type Tracked = { kind: SessionRowStatusKind; pending: Set<string>; at: number; backgroundWork?: BackgroundWork }

function tracked(kind: SessionRowStatusKind, at: number, pending = new Set<string>()): Tracked {
  return { kind, pending, at }
}

function rowStatus(entry: Tracked): SessionRowStatus {
  return { kind: entry.kind, awaitingInput: entry.pending.size > 0, at: entry.at, ...(entry.backgroundWork ? { backgroundWork: entry.backgroundWork } : {}) }
}

/**
 * Every `wr/events` data frame is `{ directory, payload }` and the payloads
 * this reads are presentation events, `{ type, properties }`.
 */
function presentationEventOf(frame: unknown): { type: string; properties: Record<string, unknown> } | undefined {
  const payload = record(record(frame)?.payload)
  const type = raw(payload?.type)
  const properties = record(payload?.properties)
  return type && properties ? { type, properties } : undefined
}

/**
 * Session status as the daemon observes it: from the frames of every runtime
 * mounted in this process, and on demand from those runtimes' own answers.
 * `awaitingInput` is an open permission or question, held until it is
 * replied, rejected or expired.
 */
export function createRuntimeSessionStatus(options: RuntimeSessionStatusOptions): RuntimeSessionStatus {
  const now = options.now ?? Date.now
  const workspaces = new Map<string, Map<string, Tracked>>()
  const attached = new Map<ObservedRuntime, () => void>()
  const snapshotAt = new Map<string, number>()

  const sessionsOf = (workspaceId: string) => {
    const sessions = workspaces.get(workspaceId) ?? new Map<string, Tracked>()
    workspaces.set(workspaceId, sessions)
    return sessions
  }

  const entryOf = (workspaceId: string, sessionId: string) => {
    const sessions = sessionsOf(workspaceId)
    const entry = sessions.get(sessionId) ?? tracked("idle", now())
    sessions.set(sessionId, entry)
    return entry
  }

  const applyFrame = (workspaceId: string, frame: unknown) => {
    const event = presentationEventOf(frame)
    const sessionId = event && raw(event.properties.sessionID)
    if (!event || !sessionId) return
    const entry = entryOf(workspaceId, sessionId)
    switch (event.type) {
      case "message.completed":
        break
      case "session.background-work":
        entry.backgroundWork = parseBackgroundWork(event.properties)
        break
      case "session.status":
        entry.kind = runtimeStatusKind(event.properties.status)
        break
      case "session.idle":
      case "session.error":
        entry.kind = "idle"
        break
      case "permission.asked":
      case "question.asked": {
        const id = raw(event.properties.id)
        if (id) entry.pending.add(`${event.type}:${id}`)
        break
      }
      case "permission.replied":
      case "permission.expired":
      case "question.replied":
      case "question.rejected":
      case "question.expired": {
        const requestId = raw(event.properties.requestID)
        if (requestId) entry.pending.delete(`${event.type.split(".")[0]}.asked:${requestId}`)
        break
      }
      default:
        return
    }
    entry.at = now()
    options.onChange(workspaceId, sessionId)
  }

  const runtimeGone = (workspaceId: string) => {
    const sessions = workspaces.get(workspaceId)
    workspaces.delete(workspaceId)
    snapshotAt.delete(workspaceId)
    if (!sessions) return
    for (const [sessionId, entry] of sessions) {
      if (entry.kind === "idle" && entry.pending.size === 0) continue
      options.onChange(workspaceId, sessionId)
    }
  }

  const stopObserving = options.observe((runtime, phase) => {
    if (phase === "retired") return
    if (phase === "disposed") {
      attached.get(runtime)?.()
      attached.delete(runtime)
      runtimeGone(runtime.workspace.id)
      return
    }
    if (attached.has(runtime)) return
    attached.set(runtime, runtime.frames.subscribe((frame) => applyFrame(runtime.workspace.id, frame)))
  })

  const snapshot = async (workspaceId: string) => {
    const activity = await readRuntimeSessionActivity(options.read, workspaceId)
    const at = now()
    if (!activity) {
      workspaces.delete(workspaceId)
      snapshotAt.delete(workspaceId)
      return undefined
    }
    const sessions = new Map([...activity].map(([sessionId, entry]) => [sessionId, { ...tracked(entry.kind, at, entry.pending), backgroundWork: entry.backgroundWork }]))
    workspaces.set(workspaceId, sessions)
    snapshotAt.set(workspaceId, at)
    return new Map([...sessions].map(([sessionId, entry]) => [sessionId, rowStatus(entry)]))
  }

  return {
    current: (workspaceId, sessionId) => {
      const entry = workspaces.get(workspaceId)?.get(sessionId)
      const at = snapshotAt.get(workspaceId)
      return entry ? rowStatus(entry) : at === undefined ? undefined : { kind: "idle", awaitingInput: false, at }
    },
    snapshot,
    stop: () => {
      stopObserving()
      for (const detach of attached.values()) detach()
      attached.clear()
      workspaces.clear()
      snapshotAt.clear()
    },
  }
}
