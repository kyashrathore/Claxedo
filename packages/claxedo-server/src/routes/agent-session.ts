import { HTTPException } from "hono/http-exception"
import { OpenCodeAdapter } from "../../../workspace-runtime/src"
import type { CompatEnvelope } from "../../../workspace-runtime/src/compat-events"
import { createSessionRoutes } from "../../../workspace-runtime/src/routes/session-core"
import { sessionStatusSnapshot } from "../../../workspace-runtime/src/routes/session-status-snapshot"
import { claxedoBus, globalBus, type ClaxedoEvent } from "../bus"
import { deleteCloudSession, syncCloudMessages, syncCloudSession, syncCloudSessions } from "../cloud/session-sync"
import { readSessionMessages } from "../cloud/message-replay"
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
  deleteSessionMeta,
  GLOBAL_SHOW_TAG,
  GLOBAL_TAG,
  applySessionMeta,
  sessionMeta,
  syncSessionMeta,
  syncSessionMetas,
  taggedSessionMetas,
  putSessionMeta,
} from "../session-meta"
import { opencodeHeaders } from "../opencode-auth"
import { normalize, type SessionRunner } from "../session-runner"
import { getWorkspaceByDirectory, resolveWorkspace } from "../workspace-store"

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
  return (await taggedSessionMetas([GLOBAL_TAG], { includeHidden: true })).map((item) => ({
    id: item.sessionID,
    title: item.title ?? null,
    directory: item.directory,
    parentID: item.parentID,
    rootID: item.rootID,
    tags: item.tags,
    attachments: item.attachments,
    time: {
      created: item.createdAt,
      updated: item.updatedAt,
      ...(typeof item.archived === "number" ? { archived: item.archived } : {}),
    },
  }))
}

function runner(c: {
  req: {
    header: (k: string) => string | undefined
  }
}) {
  const type = c.req.header("x-claxedo-runner")
  const binary = c.req.header("x-claxedo-binary")
  const model = c.req.header("x-claxedo-model")
  if (type !== "claude-acp" && type !== "codex-acp" && type !== "cursor-acp" && type !== "opencode") return
  return normalize({
    type,
    ...(type === "opencode" ? {} : {
      ...(binary ? { binary } : {}),
      ...(model ? { model } : {}),
    }),
  } satisfies SessionRunner)
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

export function AgentSessionRoutes() {
  return createSessionRoutes({
    resolveAdapter: async (c, input) => {
      const ws = await workspaceStrict(c as never, input)
      if (input?.sessionId) return getLocalSessionAdapter(ws, input.sessionId)
      const hit = runner(c as never)
      if (hit) return getLocalAgentAdapter(ws, hit)
      return getLocalAgentAdapter(ws, await getLocalSessionRunner(ws))
    },
    resolveDirectory: async (c, input) => (await workspace(c as never, input))?.directory || globalRoot(),
    listSessions: async (c) => {
      const ws = await workspace(c as never)
      if (!ws) return globalSessions()
      const rows = await listLocalSessions(ws)
      return applySessionMeta(
        rows.filter((item): item is Record<string, unknown> => !!item && typeof item === "object"),
      )
    },
    createSession: async (c, _directory, title) => {
      const ws = await workspace(c as never)
      if (ws) return createLocalSession(ws, runner(c as never) ?? await getLocalSessionRunner(ws), title)
      const dir = await createGlobalDirectory()
      const next = globalWorkspace(dir)
      const session = await createLocalSession(next, runner(c as never) ?? await getLocalSessionRunner(next), title)
      await syncSessionMeta(undefined, { ...session, directory: dir })
      await putSessionMeta(session.id, {
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
      if (!(adapter instanceof OpenCodeAdapter)) return sessionStatusSnapshot(await adapter.listSessions(directory))
      const url = await adapter.getServerUrl()
      const ws = await workspace(c as never)
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
      const messages = readSessionMessages(sessionId)
      return messages.length > 0 ? messages : undefined
    },
    listPermissions: async (c) => listLocalPermissions(await workspaceStrict(c as never)),
    afterListSessions: async (c, _directory, sessions) => {
      const ws = await workspace(c as never)
      if (!ws) return
      await syncSessionMetas(ws, sessions)
      await syncCloudSessions(ws, sessions)
    },
    afterCreateSession: async (c, _directory, session) => {
      const ws = await workspace(c as never)
      if (!ws || ws.id === "global") return
      await syncSessionMeta(ws, session)
      await syncCloudSession(ws, session)
    },
    afterGetSession: async (c, _directory, session) => {
      const ws = await workspace(c as never)
      if (!ws || ws.id === "global") {
        await syncSessionMeta(undefined, session)
        return
      }
      await syncSessionMeta(ws, session)
      await syncCloudSession(ws, session)
    },
    getSessionConfig: async (c, _directory, sessionId, _adapter) => {
      const ws = await workspaceStrict(c as never, { sessionId })
      return getLocalSessionConfig(ws, sessionId)
    },
    updateSessionConfig: async (c, _directory, sessionId, patch) => {
      const ws = await workspaceStrict(c as never, { sessionId })
      return updateLocalSessionConfig(ws, sessionId, patch)
    },
    afterUpdateSession: async (c, _directory, session) => {
      const ws = await workspace(c as never)
      if (!ws || ws.id === "global") {
        await syncSessionMeta(undefined, session)
        return
      }
      await syncSessionMeta(ws, session)
      await syncCloudSession(ws, session)
    },
    afterDeleteSession: async (c, _directory, sessionId) => {
      const ws = await workspace(c as never)
      await deleteSessionMeta(sessionId)
      if (!ws || ws.id === "global") return
      await deleteCloudSession(ws, sessionId)
    },
    afterMessages: async (c, _directory, sessionId, messages) => {
      const ws = await workspace(c as never)
      if (!ws || ws.id === "global") return
      await syncCloudMessages(ws, sessionId, messages)
    },
    sessionBus: claxedoBus,
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
