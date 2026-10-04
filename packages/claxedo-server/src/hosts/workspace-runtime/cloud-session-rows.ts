import { decodeJwt } from "jose"
import { Hono } from "hono"
import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { RuntimeStore } from "@claxedo/session-core"
import type { WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { workspaceId } from "@claxedo/workspace-runtime/host"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionRowStatus } from "@claxedo/server-core/session/navigation-list"
import { SESSION_ROWS_PASS_PATH, type SessionRowsPassHeld } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { createRuntimeSessionStatus } from "@claxedo/server-core/session/publish/runtime-session-status"
import { createSessionRowsPublisher, type SessionRowSource } from "@claxedo/server-core/session/publish/session-rows-publisher"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { controlPlaneOrigin } from "./tasks-grant"
import { controlPlaneOnly } from "./control-plane-only"
import { expiryOf, halfLifeRenewal, nodeRenewalTimers, type RenewalOutcome, type RenewalTimers } from "./half-life-renewal"

const log = Log.create({ service: "cloud-session-rows" })

type SessionReads = Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionReads"]>>[0]
type RuntimeSession = ReturnType<RuntimeStore["listEverySession"]>[number]
type FrameListener = (frame: unknown) => void

export type CloudSessionRows = Required<Pick<WorkspaceRuntimeServerOptions, "onPresentationEvent" | "bindSessionReads" | "beforeStoreClose">> & {
  /** Where the control plane hands this runtime its pass, and asks which one it holds. */
  routes: WorkspaceRuntimeRouteContribution
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

function held(token: string | undefined): SessionRowsPassHeld {
  if (!token) return null
  try {
    const claims = decodeJwt(token)
    const epoch = Number(claims.lease_epoch)
    if (!Number.isSafeInteger(epoch) || typeof claims.iat !== "number" || typeof claims.exp !== "number") return null
    return { epoch, issuedAt: claims.iat * 1_000, expiresAt: claims.exp * 1_000 }
  } catch {
    return null
  }
}

/**
 * A cloud runtime's publisher of its sessions' list rows: the shared
 * publisher and status tracker, fed from this runtime's own presentation
 * events and store, every session of the workspace whatever directory it is
 * filed under (a worktree session's is its worktree). It publishes nothing
 * until the control plane, as its service actor over the relay, hands it a
 * session rows pass for its lease epoch; it renews that pass at half-life,
 * and a pass the control plane hands it later replaces it.
 */
export function cloudSessionRows(
  env: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; now?: () => number; timers?: RenewalTimers } = {},
): CloudSessionRows | undefined {
  const origin = controlPlaneOrigin(env)
  if (!origin) return undefined
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const url = new URL("/api/claxedo/host/session-rows", origin).toString()
  const workspace = workspaceId(env)
  const hostId = env.WORKSPACE_RUNTIME_HOST_ID?.trim() || workspace
  const frames = new Set<FrameListener>()
  let reads: SessionReads | undefined
  let token: string | undefined

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
      return Response.json(path === "/permission" ? reads.store().listEveryPermission() : reads.store().listEveryQuestion())
    },
    onChange: (workspaceId, sessionId) => publisher.sessionChanged(workspaceId, sessionId),
  })
  const source: SessionRowSource = {
    listRows: async (workspaceId) => {
      const store = mounted().store()
      const live = await status.snapshot(workspaceId)
      return store.listEverySession()
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

  const adopt = (next: string) => {
    const expiresAt = expiryOf(next)
    if (expiresAt === undefined) return false
    token = next
    publisher.credentialChanged({ hostId, token, workspaceIds: [workspace] })
    renewal.track(expiresAt)
    return true
  }
  const renew = async (): Promise<RenewalOutcome> => {
    const sent = token
    try {
      const response = await send(url, {
        method: "POST",
        headers: { authorization: `Bearer ${sent}`, "content-type": "application/json" },
        body: JSON.stringify({ hostId, rows: [], removed: [] }),
      })
      if (response.status === 401) {
        log.warn("session rows pass refused; waiting for the control plane to deliver one", { workspaceId: workspace })
        return { kind: "refused" }
      }
      const next = stringField(asRecord(asRecord(await response.json().catch(() => undefined))?.credential), "token")
      const expiresAt = next === undefined ? undefined : expiryOf(next)
      if (!response.ok || !next || expiresAt === undefined) throw new Error(`control plane answered ${response.status} without a pass`)
      if (token !== sent) return { kind: "refused" }
      token = next
      publisher.credentialChanged({ hostId, token, workspaceIds: [workspace] })
      return { kind: "renewed", expiresAt }
    } catch (error) {
      log.warn("session rows pass renewal failed", { workspaceId: workspace, error: String(error) })
      return { kind: "failed" }
    }
  }
  const renewal = halfLifeRenewal({
    renew,
    lapsed: () => log.warn("session rows pass lapsed; waiting for the control plane to deliver one", { workspaceId: workspace }),
    now,
    timers: options.timers ?? nodeRenewalTimers(),
  })

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
    beforeStoreClose: () => publisher.flush(),
    routes: {
      id: "session-rows",
      mount: () => {
        const routes = new Hono()
        routes.use(SESSION_ROWS_PASS_PATH, controlPlaneOnly("Only the control plane hands this runtime its session rows pass"))
        routes.get(SESSION_ROWS_PASS_PATH, (c) => c.json({ held: held(token) }))
        routes.put(SESSION_ROWS_PASS_PATH, async (c) => {
          const next = stringField(asRecord(await c.req.json().catch(() => undefined)), "token")
          if (!next || !adopt(next)) return c.json({ error: { code: "invalid_session_rows_pass", message: "A session rows pass is required" } }, 400)
          return c.body(null, 204)
        })
        return { path: "/", routes, dispose: () => {} }
      },
    },
    stop: () => {
      renewal.stop()
      publisher.stop()
      status.stop()
    },
  }
}
