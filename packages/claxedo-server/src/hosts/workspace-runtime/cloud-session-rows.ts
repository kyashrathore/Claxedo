import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { RuntimeStore } from "@claxedo/session-core"
import type { WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import { workspaceId } from "@claxedo/workspace-runtime/host"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionRowStatus } from "@claxedo/server-core/session/navigation-list"
import { WORKSPACE_RUNTIME_SESSION_ROWS_PASS } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { createRuntimeSessionStatus } from "@claxedo/server-core/session/publish/runtime-session-status"
import { createSessionRowsPublisher, type SessionRowSource } from "@claxedo/server-core/session/publish/session-rows-publisher"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { controlPlaneOrigin, expiryOf } from "./tasks-grant"

const log = Log.create({ service: "cloud-session-rows" })
const RENEWAL_RETRY_MS = 30_000

type SessionReads = Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionReads"]>>[0]
type RuntimeSession = ReturnType<RuntimeStore["listSessions"]>[number]
type FrameListener = (frame: unknown) => void

export type CloudSessionRows = Required<Pick<WorkspaceRuntimeServerOptions, "onPresentationEvent" | "bindSessionReads">> & {
  stop: () => void
}

function hostSessionRow(workspaceId: string, session: RuntimeSession, status: SessionRowStatus): HostSessionRow {
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
 * A cloud runtime's publisher of its sessions' list rows: the shared
 * publisher and status tracker, fed from this runtime's own presentation
 * events and store, every session of the workspace whatever directory it is
 * filed under (a worktree session's is its worktree), and sent with the session rows pass the control plane
 * launched this lease epoch with. At half the pass's life it trades it for a
 * fresh one through the same endpoint; once the control plane refuses that,
 * the epoch is over and nothing more is published or renewed.
 */
export function cloudSessionRows(
  env: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): CloudSessionRows | undefined {
  const initial = env[WORKSPACE_RUNTIME_SESSION_ROWS_PASS]?.trim()
  const origin = controlPlaneOrigin(env)
  if (!initial || !origin) return undefined
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const url = new URL("/api/claxedo/host/session-rows", origin).toString()
  const workspace = workspaceId(env)
  const hostId = env.WORKSPACE_RUNTIME_HOST_ID?.trim() || workspace
  const frames = new Set<FrameListener>()
  let reads: SessionReads | undefined
  let token = initial
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const mounted = () => {
    if (!reads) throw new Error("the workspace runtime has not bound its session reads yet")
    return reads
  }
  const status = createRuntimeSessionStatus({
    observe: (listener) => {
      listener({ workspace: { id: workspace }, frames: { subscribe: (fn) => (frames.add(fn), () => frames.delete(fn)) } }, "mounted")
      return () => frames.clear()
    },
    read: async (_workspaceId, path) => {
      if (!reads) return undefined
      if (path === "/session/status") return Response.json(reads.sessionStatus())
      return Response.json(path === "/permission" ? reads.store().listPermissions() : reads.store().listQuestions())
    },
    onChange: (workspaceId, sessionId) => publisher.sessionChanged(workspaceId, sessionId),
  })
  const source: SessionRowSource = {
    listRows: async (workspaceId) => {
      const store = mounted().store()
      const live = await status.snapshot(workspaceId)
      return store.listSessions()
        .filter((session) => !session.parentID)
        .map((session) => hostSessionRow(workspaceId, session, live.get(session.id) ?? status.current(workspaceId, session.id)))
    },
    readRow: async (workspaceId, sessionId) => {
      const session = mounted().store().getSession(sessionId)
      if (!session) return { kind: "absent" }
      if (session.parentID) return { kind: "child" }
      return { kind: "row", row: hostSessionRow(workspaceId, session, status.current(workspaceId, sessionId)) }
    },
  }
  const publisher = createSessionRowsPublisher({ source, url: () => url, ...(options.fetch ? { fetch: options.fetch } : {}) })

  const schedule = (ms: number) => {
    if (stopped) return
    timer = setTimeout(() => void renew(), Math.max(0, ms))
    timer.unref?.()
  }
  const adopt = (next: string) => {
    token = next
    publisher.credentialChanged({ hostId, token, workspaceIds: [workspace] })
    const expiresAt = expiryOf(next)
    if (expiresAt !== undefined) schedule((expiresAt - now()) / 2)
  }
  const renew = async () => {
    const remaining = (expiryOf(token) ?? 0) - now()
    try {
      const response = await send(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hostId, rows: [], removed: [] }),
      })
      if (response.status === 401) {
        log.warn("session rows pass refused; this epoch publishes no more rows", { workspaceId: workspace })
        return
      }
      const next = stringField(asRecord(asRecord(await response.json().catch(() => undefined))?.credential), "token")
      if (!response.ok || !next) throw new Error(`control plane answered ${response.status} without a pass`)
      adopt(next)
    } catch (error) {
      log.warn("session rows pass renewal failed", { workspaceId: workspace, error: String(error) })
      if (remaining > 0) schedule(Math.min(RENEWAL_RETRY_MS, remaining))
    }
  }

  adopt(initial)
  return {
    onPresentationEvent: (event: AgentEventEnvelope) => {
      for (const listener of frames) listener(event)
      const payload = event.payload
      if (payload.type === "session.updated") publisher.sessionChanged(workspace, payload.properties.sessionID)
      if (payload.type === "session.deleted" && !payload.properties.info.parentID) publisher.sessionRemoved(workspace, payload.properties.info.id)
    },
    bindSessionReads: (bound) => {
      reads = bound
    },
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      publisher.stop()
      status.stop()
    },
  }
}
