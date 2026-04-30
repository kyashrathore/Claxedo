import { HTTPException } from "hono/http-exception"
import { OpenCodeAdapter } from "../../../workspace-runtime/src"
import type { ClaxedoEvent as RuntimeClaxedoEvent } from "../../../workspace-runtime/src/bus"
import type { CompatEnvelope } from "../../../workspace-runtime/src/compat-events"
import { createSessionRoutes } from "../../../workspace-runtime/src/routes/session-core"
import { sessionStatusSnapshot } from "../../../workspace-runtime/src/routes/session-status-snapshot"
import { claxedoBus, globalBus, type ClaxedoEvent } from "../bus"
import { createGlobalDirectory, globalRoot, globalWorkspace } from "../global-session"
import {
  createLocalSession,
  getLocalAgentAdapter,
  getLocalSessionAdapter,
  getLocalSessionConfig,
  getLocalSessionRunner,
  listLocalPermissions,
  listLocalSessions,
  updateLocalSessionConfig,
} from "../local-agent-engine"
import {
  GLOBAL_SHOW_TAG,
  GLOBAL_TAG,
  applySessionMeta,
  type SessionMeta,
  sessionMeta,
  taggedSessionMetas,
} from "../session-meta"
import { opencodeHeaders } from "../opencode-auth"
import { normalize, type SessionRunner } from "../session-runner"
import { getWorkspaceByDirectory, resolveWorkspace } from "../workspace-store"
import { getHarnessHost } from "../harness/host"
import { parseRunner, resolveRunnerForRequest, resolveRunnerHostForRequest } from "../runner-resolution"
import { decodePiModel } from "../harness/pi-support"
import type { ControlPlaneServices } from "../control-plane/services"

async function workspace(c: {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
    param?: (k: string) => string
  }
}, input?: {
  sessionId?: string
}) {
  const hit = await resolveWorkspace({
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
    create: !!(c.req.query("directory") || c.req.header("x-opencode-directory")),
  })
  if (hit) return hit
  const sessionId = input?.sessionId || c.req.param?.("id") || c.req.param?.("sessionId")
  if (!sessionId) return
  const meta = await sessionMeta(sessionId)
  if (!meta?.directory) return
  const ws = await resolveWorkspace({
    directory: meta.directory,
  })
  if (ws) return ws
  if (!meta.tags.includes(GLOBAL_TAG)) return
  return globalWorkspace(meta.directory)
}

async function workspaceStrict(c: {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
    param?: (k: string) => string
  }
}, input?: {
  sessionId?: string
}) {
  const hit = await workspace(c, input)
  if (hit) return hit
  throw new HTTPException(400, { message: "workspaceId or directory is required" })
}

async function globalSessions() {
  return (await taggedSessionMetas([GLOBAL_TAG], { includeHidden: true })).map(sessionRowFromMeta)
}

function sessionRowFromMeta(input: SessionMeta) {
  return {
    id: input.sessionID,
    title: input.title ?? null,
    directory: input.directory,
    ...(input.parentID ? { parentID: input.parentID } : {}),
    ...(input.rootID ? { rootID: input.rootID } : {}),
    ...(input.projectID ? { projectID: input.projectID } : {}),
    tags: input.tags,
    attachments: input.attachments,
    time: {
      created: input.createdAt,
      updated: input.updatedAt,
      ...(typeof input.archived === "number" ? { archived: input.archived } : {}),
    },
  }
}

function runner(c: {
  req: {
    header: (k: string) => string | undefined
  }
}) {
  return parseRunner({
    type: c.req.header("x-claxedo-runner"),
    binary: c.req.header("x-claxedo-binary"),
    model: c.req.header("x-claxedo-model"),
  })
}

// ── Compat → agent.lifecycle bridge ──────────────────────────────────────────
// Translates workspace-runtime compat events into claxedoBus agent.lifecycle
// events so the frontend has a single unified event source for all runners.

function bridgeLifecycleEvent(event: CompatEnvelope) {
  const { type, properties } = event.payload as { type: string; properties?: Record<string, unknown> }
  const sessionID = (properties?.sessionID ?? properties?.sessionId) as string | undefined

  let eventType: "Busy" | "Idle" | "UserActionRequired" | "Error" | undefined
  if (type === "session.status") {
    const status = properties?.status as { type: string } | undefined
    if (status?.type === "busy") eventType = "Busy"
  } else if (type === "permission.asked" || type === "question.asked") {
    eventType = "UserActionRequired"
  } else if (type === "session.idle") {
    eventType = "Idle"
  } else if (type === "session.error") {
    eventType = "Error"
  }
  if (!eventType) return

  const directory = event.directory
  getWorkspaceByDirectory(directory).then((ws) => {
    const lifecycle: ClaxedoEvent = {
      type: "agent.lifecycle",
      tabId: sessionID ?? directory,
      workspaceId: ws?.id,
      sessionId: sessionID,
      eventType,
    }
    claxedoBus.publish(lifecycle)
  }).catch(() => {
    // workspace lookup failed — still publish without workspaceId
    const lifecycle: ClaxedoEvent = {
      type: "agent.lifecycle",
      tabId: sessionID ?? directory,
      sessionId: sessionID,
      eventType: eventType!,
    }
    claxedoBus.publish(lifecycle)
  })
}

function sessionEvent(event: ClaxedoEvent): event is RuntimeClaxedoEvent {
  return event.type !== "provision" && event.type !== "worktree.ready" && event.type !== "worktree.failed"
}

const sessionBus = {
  publish(event: RuntimeClaxedoEvent) {
    claxedoBus.publish(event)
  },
  subscribe(fn: (event: RuntimeClaxedoEvent) => void) {
    return claxedoBus.subscribe((event) => {
      if (!sessionEvent(event)) return
      fn(event)
    })
  },
}

export function AgentSessionRoutes(services: ControlPlaneServices) {
  const projectionStore = services.projectionStore
  return createSessionRoutes({
    resolveAdapter: async (c, input) => {
      const ws = await workspaceStrict(c as never, input)
      const host = await resolveRunnerHostForRequest({
        sessionId: input?.sessionId,
        workspaceId: ws.id,
        directory: ws.directory,
        type: c.req.header("x-claxedo-runner"),
        binary: c.req.header("x-claxedo-binary"),
        model: c.req.header("x-claxedo-model"),
      })
      if (host === "central") return getHarnessHost(projectionStore).createAdapter(ws)
      if (input?.sessionId) return getLocalSessionAdapter(ws, input.sessionId)
      const hit = runner(c as never)
      if (hit) return getLocalAgentAdapter(ws, hit)
      return getLocalAgentAdapter(ws, await getLocalSessionRunner(ws))
    },
    resolveDirectory: async (c, input) => (await workspace(c as never, input))?.directory || globalRoot(),
    listSessions: async (c) => {
      const ws = await workspace(c as never)
      if (!ws) return globalSessions()
      if (ws.kind === "cloud") {
        const rows = await projectionStore.list_session_metas({
          workspaceID: ws.id,
          directory: ws.directory,
        })
        return rows.map((item) => ({
          ...sessionRowFromMeta(item),
          ...(ws.project_id ? { projectID: ws.project_id } : {}),
        }))
      }
      const central = await getHarnessHost(projectionStore).createAdapter(ws).then((adapter) => adapter.listSessions(ws.directory)).catch(() => [])
      const local = await listLocalSessions(ws)
      const merged = new Map<string, Record<string, unknown>>()
      for (const row of [...central, ...local]) {
        if (!row || typeof row !== "object") continue
        const id = (row as { id?: unknown }).id
        if (typeof id !== "string") continue
        merged.set(id, row as Record<string, unknown>)
      }
      const rows = [...merged.values()]
      const filtered = rows.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      // Canonicalize projectID to the resolved workspace's project_id
      if (ws.project_id) {
        for (const row of filtered) row.projectID = ws.project_id
      }
      return applySessionMeta(filtered)
    },
    createSession: async (c, _directory, title) => {
      const hit = runner(c as never)
      const next = hit ?? await resolveRunnerForRequest({
        type: c.req.header("x-claxedo-runner"),
        binary: c.req.header("x-claxedo-binary"),
        model: c.req.header("x-claxedo-model"),
      })
      if ((await resolveRunnerHostForRequest(next)) === "central") {
        const patch = {
          runner: next,
          ...(next.type === "pi" && next.model
            ? (() => {
                const model = decodePiModel(next.model)
                return model ? { model } : {}
              })()
            : {}),
        }
        const ws = await workspace(c as never)
        if (ws) {
          const adapter = await getHarnessHost(projectionStore).createAdapter(ws)
          const session = await adapter.createSession(ws.directory, title)
          await adapter.updateSessionConfig(session.id, patch, ws.directory).catch(() => {})
          return session
        }
        const dir = await createGlobalDirectory()
        const root = globalWorkspace(dir)
        const adapter = await getHarnessHost(projectionStore).createAdapter(root)
        const session = await adapter.createSession(dir, title)
        await adapter.updateSessionConfig(session.id, patch, dir).catch(() => {})
        await projectionStore.put_session_meta(session.id, {
          ws: root,
          directory: dir,
          title: title ?? null,
          tags: [GLOBAL_TAG, GLOBAL_SHOW_TAG],
        })
        return {
          ...session,
          directory: dir,
        }
      }
      const ws = await workspace(c as never)
      if (ws) return createLocalSession(ws, next, title)
      const dir = await createGlobalDirectory()
      const root = globalWorkspace(dir)
      const session = await createLocalSession(root, hit ?? await getLocalSessionRunner(root), title)
      await projectionStore.sync_session_meta(undefined, { ...session, directory: dir })
      await projectionStore.put_session_meta(session.id, {
        directory: dir,
        title,
        tags: [GLOBAL_TAG, GLOBAL_SHOW_TAG],
      })
      return {
        ...session,
        directory: dir,
      }
    },
    getStatus: async (c, directory, adapter) => {
      const ws = await workspace(c as never)
      const host = await resolveRunnerHostForRequest({
        workspaceId: ws?.id,
        directory,
        type: c.req.header("x-claxedo-runner"),
        binary: c.req.header("x-claxedo-binary"),
        model: c.req.header("x-claxedo-model"),
      })
      if (host === "central") return sessionStatusSnapshot(await adapter.listSessions(directory))
      if (!(adapter instanceof OpenCodeAdapter)) return sessionStatusSnapshot(await adapter.listSessions(directory))
      const url = await adapter.getServerUrl()
      const res = await fetch(`${url}/session/status`, {
        headers: opencodeHeaders({
          "x-opencode-directory": directory,
          ...(ws ? { "x-workspace-id": ws.id } : {}),
        }),
      })
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    },
    getMessages: async (_c, _directory, sessionId) => {
      const messages = projectionStore.read_session_messages(sessionId)
      return messages.length > 0 ? messages : undefined
    },
    listPermissions: async (c) => {
      const ws = await workspaceStrict(c as never)
      const [central, local] = await Promise.all([
        getHarnessHost(projectionStore).createAdapter(ws).then((adapter) => adapter.listPermissions(ws.directory)).catch(() => []),
        listLocalPermissions(ws),
      ])
      return [...central, ...local]
    },
    afterListSessions: async (c, _directory, sessions) => {
      const ws = await workspace(c as never)
      if (!ws) return
      await projectionStore.sync_session_metas(ws, sessions)
    },
    afterCreateSession: async (c, _directory, session) => {
      const ws = await workspace(c as never)
      const host = await resolveRunnerHostForRequest({
        workspaceId: ws?.id,
        directory: ws?.directory,
        sessionId: typeof (session as { id?: unknown })?.id === "string" ? (session as { id: string }).id : undefined,
        type: c.req.header("x-claxedo-runner"),
        binary: c.req.header("x-claxedo-binary"),
        model: c.req.header("x-claxedo-model"),
      })
      if (host === "central") return
      if (!ws || ws.id === "global") return
      await projectionStore.sync_session_meta(ws, session)
    },
    afterGetSession: async (c, _directory, session) => {
      const ws = await workspace(c as never)
      const host = await resolveRunnerHostForRequest({
        workspaceId: ws?.id,
        directory: ws?.directory,
        sessionId: typeof (session as { id?: unknown })?.id === "string" ? (session as { id: string }).id : undefined,
      })
      if (host === "central") return
      if (!ws || ws.id === "global") {
        await projectionStore.sync_session_meta(undefined, session)
        return
      }
      await projectionStore.sync_session_meta(ws, session)
    },
    getSessionConfig: async (c, directory, sessionId, adapter) => {
      const ws = await workspaceStrict(c as never, { sessionId })
      const host = await resolveRunnerHostForRequest({
        workspaceId: ws.id,
        directory,
        sessionId,
      })
      if (host === "central") return adapter.getSessionConfig(sessionId, directory)
      return getLocalSessionConfig(ws, sessionId)
    },
    updateSessionConfig: async (c, directory, sessionId, patch, adapter) => {
      const ws = await workspaceStrict(c as never, { sessionId })
      const host = await resolveRunnerHostForRequest({
        workspaceId: ws.id,
        directory,
        sessionId,
      })
      if (host === "central") return adapter.updateSessionConfig(sessionId, patch, directory)
      return updateLocalSessionConfig(ws, sessionId, patch)
    },
    afterUpdateSession: async (c, _directory, session) => {
      const ws = await workspace(c as never)
      const host = await resolveRunnerHostForRequest({
        workspaceId: ws?.id,
        directory: ws?.directory,
        sessionId: typeof (session as { id?: unknown })?.id === "string" ? (session as { id: string }).id : undefined,
      })
      if (host === "central") return
      if (!ws || ws.id === "global") {
        await projectionStore.sync_session_meta(undefined, session)
        return
      }
      await projectionStore.sync_session_meta(ws, session)
    },
    afterDeleteSession: async (c, _directory, sessionId) => {
      const ws = await workspace(c as never)
      const host = await resolveRunnerHostForRequest({
        workspaceId: ws?.id,
        directory: ws?.directory,
        sessionId,
      })
      if (host === "central") {
        await projectionStore.delete_session_meta(sessionId)
        return
      }
      await projectionStore.delete_session_meta(sessionId)
    },
    sessionBus,
    publishGlobal: (event) => {
      globalBus.publish({
        directory: event.directory,
        payload: event.payload,
      })
      bridgeLifecycleEvent(event)
      // Message persistence is handled by subscribeMessageReplay on globalBus
      // (covers both local and cloud workspaces from a single convergence point)
    },
  })
}
