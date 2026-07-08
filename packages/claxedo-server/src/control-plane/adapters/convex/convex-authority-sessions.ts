import type { SignedControlPlaneAuth } from "../../auth"
import { isCliAccessAuth } from "../../cli-session-token"
import { convexApi } from "./convex-authority-api"
import { requireAllowed, requireExecutor } from "./convex-authority-executor"
import type { ConvexAuthorityInput, ServiceArgs } from "./convex-authority-types"

type SessionVisibility = {
  sessionId: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

export function sessionAuthority(input: ConvexAuthorityInput, serviceArgs: ServiceArgs) {
  return {
    async authorizeSessionRead(auth: SignedControlPlaneAuth, args: {
      sessionId: string
      workspaceId: string
    }) {
      await requireAllowed(await requireExecutor(input, auth).query(convexApi.sessions.authorizeRead, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
      }))
    },
    async listSessions(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      return requireExecutor(input, auth).query(convexApi.sessions.list, {
        workspace_id: args.workspaceId,
      })
    },
    async readSessionMessages(auth: SignedControlPlaneAuth, args: {
      sessionId: string
      workspaceId: string
    }) {
      return requireExecutor(input, auth).query(convexApi.sessions.readMessages, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
      })
    },
    async syncSessionMessages(auth: SignedControlPlaneAuth, args: {
      sessionId: string
      workspaceId: string
      messages: unknown[]
    }) {
      const body = {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        messages: args.messages,
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(convexApi.sessions.syncMessagesForService, {
          ...serviceArgs(auth),
          ...body,
        })
      }
      return requireExecutor(input, auth).mutation(convexApi.sessions.syncMessages, body)
    },
    async upsertSessionVisibility(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      sessions: SessionVisibility[]
    }) {
      const body = {
        workspace_id: args.workspaceId,
        sessions: sessionVisibilityRows(args.sessions),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(convexApi.sessions.upsertVisibilityForService, {
          ...serviceArgs(auth),
          ...body,
        })
      }
      return requireExecutor(input, auth).mutation(convexApi.sessions.upsertVisibility, body)
    },
    async replaceSessionVisibility(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      sessions: SessionVisibility[]
    }) {
      const body = {
        workspace_id: args.workspaceId,
        sessions: sessionVisibilityRows(args.sessions),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(convexApi.sessions.replaceVisibilityForService, {
          ...serviceArgs(auth),
          ...body,
        })
      }
      return requireExecutor(input, auth).mutation(convexApi.sessions.replaceVisibility, body)
    },
    async deleteSessionVisibility(auth: SignedControlPlaneAuth, args: {
      sessionId: string
      workspaceId: string
    }) {
      const body = {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(convexApi.sessions.deleteVisibilityForService, {
          ...serviceArgs(auth),
          ...body,
        })
      }
      return requireExecutor(input, auth).mutation(convexApi.sessions.deleteVisibility, body)
    },
  }
}

function sessionVisibilityRows(sessions: SessionVisibility[]) {
  return sessions.map((session) => ({
    session_id: session.sessionId,
    ...(session.title ? { title: session.title } : {}),
    ...(session.createdAt === undefined ? {} : { created_at: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updated_at: session.updatedAt }),
  }))
}
