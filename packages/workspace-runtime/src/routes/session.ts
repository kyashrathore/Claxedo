import { HTTPException } from "hono/http-exception"
import { createSessionRoutes } from "./session-core"
import type { AgentAdapter, PromptInput } from "../adapters/index"
import { OpenCodeAdapter } from "../adapters/opencode"
import { claxedoBus } from "../bus"
import { withDir } from "../compat-events"
import { publishGlobalEvent } from "../global-event-bus"
import { assertTarget } from "../target"
import { sessionStatusSnapshot } from "./session-status-snapshot"
import { createControlPlaneClient } from "../control-plane-client"

function dir(c: {
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined }
}): string {
  try {
    return assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
  } catch (err) {
    throw new HTTPException(400, { message: (err as Error).message })
  }
}

export function SessionRoutes(getAdapter: () => AgentAdapter) {
  const controlPlane = createControlPlaneClient()
  return createSessionRoutes({
    resolveAdapter: async () => getAdapter(),
    resolveDirectory: (c) => dir(c as never),
    getStatus: async (_c, directory, adapter) => {
      if (!(adapter instanceof OpenCodeAdapter)) return sessionStatusSnapshot(await adapter.listSessions(directory))
      const url = await adapter.getServerUrl()
      const res = await fetch(`${url}/session/status`, {
        headers: {
          "x-opencode-directory": directory,
        },
      })
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    },
    afterListSessions: async (_c, _directory, sessions) => {
      await controlPlane?.session.syncMany(sessions)
    },
    afterCreateSession: async (_c, _directory, session) => {
      await controlPlane?.session.sync(session)
    },
    afterGetSession: async (_c, _directory, session) => {
      await controlPlane?.session.sync(session)
    },
    afterUpdateSession: async (_c, _directory, session) => {
      await controlPlane?.session.sync(session)
    },
    afterDeleteSession: async (_c, _directory, sessionId) => {
      await controlPlane?.session.delete(sessionId)
    },
    sessionBus: claxedoBus,
    publishGlobal: publishGlobalEvent,
  })
}
