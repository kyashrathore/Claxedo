import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { RuntimeStore, SessionStatusSnapshot } from "@claxedo/session-core"
import type { HostSessionRow } from "../../platform/auth/host-session-rows"
import type { SessionRowStatus } from "../navigation-list"
import { createRuntimeSessionStatus } from "./runtime-session-status"
import { createSessionRowsPublisher, type SessionRowsPublisher, type SessionRowSource } from "./session-rows-publisher"

type RuntimeSession = ReturnType<RuntimeStore["listEverySession"]>[number]

/** What a runtime's row source reads of its own store: every session, whatever directory it is filed under. */
export type RuntimeSessionStoreReads = Pick<RuntimeStore, "listEverySession" | "getSession" | "listEveryPermission" | "listEveryQuestion">

export type RuntimeSessionRows = {
  publisher: SessionRowsPublisher
  /** Every presentation event the runtime emits: status, waits and background work move a row, a session update republishes it. */
  onPresentationEvent: (event: AgentEventEnvelope) => void
  stop: () => void
}

export function hostSessionRow(workspaceId: string, session: RuntimeSession, status: SessionRowStatus): HostSessionRow {
  const { time, lastTurn } = session
  return {
    workspaceId,
    sessionId: session.id,
    ...(session.title ? { title: session.title } : {}),
    createdAt: time.created,
    updatedAt: time.updated,
    ...(time.lastHumanTurn !== undefined ? { lastHumanTurnAt: time.lastHumanTurn } : {}),
    ...(time.archived !== undefined ? { archivedAt: time.archived } : {}),
    status,
    ...(lastTurn ? { lastTurn: { status: lastTurn.status, completedAt: lastTurn.completedAt } } : {}),
  }
}

/**
 * A runtime's own sessions' list rows: the shared publisher and status
 * tracker fed from this runtime's presentation events and store, every root
 * session of the workspace whatever directory it is filed under. The
 * credential it publishes under is the caller's: a sandbox holds a session
 * rows pass, a session host its turn lease.
 */
export function createRuntimeSessionRows(input: {
  workspaceId: string
  url: string
  store: () => RuntimeSessionStoreReads
  /** What the runtime answers `GET /session/status` with, read in process. */
  sessionStatus: () => SessionStatusSnapshot
  fetch?: typeof fetch
  now?: () => number
}): RuntimeSessionRows {
  const { workspaceId } = input
  const frames = new Set<(frame: unknown) => void>()
  const status = createRuntimeSessionStatus({
    observe: (listener) => {
      listener({ workspace: { id: workspaceId }, frames: { subscribe: (fn) => (frames.add(fn), () => frames.delete(fn)) } }, "mounted")
      return () => frames.clear()
    },
    read: async (_workspaceId, path) => {
      if (path === "/session/status") return Response.json(input.sessionStatus())
      return Response.json(path === "/permission" ? input.store().listEveryPermission() : input.store().listEveryQuestion())
    },
    ...(input.now ? { now: input.now } : {}),
    onChange: (changedWorkspaceId, sessionId) => publisher.sessionChanged(changedWorkspaceId, sessionId),
  })
  const source: SessionRowSource = {
    listRows: async (listedWorkspaceId) => {
      const store = input.store()
      const live = await status.snapshot(listedWorkspaceId)
      return store.listEverySession()
        .filter((session) => !session.parentID)
        .map((session) => hostSessionRow(listedWorkspaceId, session, live.get(session.id) ?? status.current(listedWorkspaceId, session.id)))
    },
    readRow: async (readWorkspaceId, sessionId) => {
      const session = input.store().getSession(sessionId)
      if (!session) return { kind: "absent" }
      if (session.parentID) return { kind: "child" }
      return { kind: "row", row: hostSessionRow(readWorkspaceId, session, status.current(readWorkspaceId, sessionId)) }
    },
  }
  const publisher = createSessionRowsPublisher({ source, url: () => input.url, ...(input.fetch ? { fetch: input.fetch } : {}) })
  return {
    publisher,
    onPresentationEvent: (event) => {
      for (const listener of frames) listener(event)
      const payload = event.payload
      if (payload.type === "session.updated") publisher.sessionChanged(workspaceId, payload.properties.sessionID)
      if (payload.type === "session.deleted" && !payload.properties.info.parentID) publisher.sessionRemoved(workspaceId, payload.properties.info.id)
    },
    stop: () => {
      publisher.stop()
      status.stop()
    },
  }
}
