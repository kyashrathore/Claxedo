import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionShareRevokeResult } from "@claxedo/server-core/platform/auth/authority"
import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { isCliAccessAuth } from "@claxedo/server-core/platform/auth/cli-session-token"
import { convexApi } from "./api"
import { requireAllowed, requireExecutor } from "./executor"
import type { ConvexAuthorityInput, ServiceArgs } from "./types"

type SessionVisibility = {
  sessionId: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

const MESSAGE_PAGE_CURSOR_PREFIX = "cawmp1:"
const MAX_MESSAGE_PAGE_LIMIT = 500

function encodeMessagePageCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ sessionId, ordinal })).toString("base64url")}`
}

function decodeMessagePageCursor(sessionId: string, input: string) {
  try {
    if (!input.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error("unexpected cursor version")
    const value = JSON.parse(Buffer.from(input.slice(MESSAGE_PAGE_CURSOR_PREFIX.length), "base64url").toString("utf8")) as {
      sessionId?: unknown
      ordinal?: unknown
    }
    if (
      value.sessionId !== sessionId
      || typeof value.ordinal !== "number"
      || !Number.isSafeInteger(value.ordinal)
      || value.ordinal < 0
    ) throw new Error("invalid cursor payload")
    return value.ordinal
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

export function sessionAuthority(input: ConvexAuthorityInput, serviceArgs: ServiceArgs) {
  return {
    async authorizeSessionRead(
      auth: SignedControlPlaneAuth,
      args: {
        sessionId: string
        workspaceId: string
      },
    ) {
      await requireAllowed(
        await requireExecutor(input, auth).query(convexApi.sessions.authorizeRead, {
          session_id: args.sessionId,
          workspace_id: args.workspaceId,
        }),
      )
    },
    async authorizeSessionWrite(
      auth: SignedControlPlaneAuth,
      args: { sessionId: string; workspaceId: string },
    ) {
      await requireAllowed(await requireExecutor(input, auth).query(convexApi.sessions.authorizeWrite, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
      }))
    },
    async authorizeRuntimeSession(args: {
      actorId: string
      actorKind: "human" | "agent"
      sessionId: string
      workspaceId: string
      action: "read" | "write"
    }) {
      await requireAllowed(await requireExecutor(input, undefined, { allowUnsigned: true }).query(
        convexApi.sessions.authorizeRuntime,
        {
          ...serviceArgs(),
          actor_id: args.actorId,
          actor_kind: args.actorKind,
          session_id: args.sessionId,
          workspace_id: args.workspaceId,
          action: args.action,
        },
      ))
    },
    async registerRuntimeSession(args: {
      actorId: string
      actorKind: "human" | "agent"
      sessionId: string
      workspaceId: string
      title?: string
    }) {
      return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
        convexApi.sessions.registerRuntime,
        {
          ...serviceArgs(),
          actor_id: args.actorId,
          actor_kind: args.actorKind,
          session_id: args.sessionId,
          workspace_id: args.workspaceId,
          ...(args.title ? { title: args.title } : {}),
        },
      )
    },
    async addSessionParticipant(
      auth: SignedControlPlaneAuth,
      args: { sessionId: string; workspaceId: string; participantTokenIdentifier: string },
    ) {
      return requireExecutor(input, auth).mutation(convexApi.sessions.addParticipant, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        participant_token_identifier: args.participantTokenIdentifier,
      })
    },
    async removeSessionParticipant(
      auth: SignedControlPlaneAuth,
      args: { sessionId: string; workspaceId: string; participantTokenIdentifier: string },
    ) {
      return requireExecutor(input, auth).mutation(convexApi.sessions.removeParticipant, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        participant_token_identifier: args.participantTokenIdentifier,
      })
    },
    async grantSessionShare(
      auth: SignedControlPlaneAuth,
      args: {
        sessionId: string
        workspaceId: string
        grantedToTokenIdentifier?: string
        grantedToClerkSubject?: string
        grantedToUserId?: string
        grantedToClerkOrgId?: string
        grantedToOrgId?: string
        grantedToTeamId?: string
        grantedToTeamPublicId?: string
      },
    ) {
      return requireExecutor(input, auth).mutation(convexApi.sessionShares.grant, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        ...(args.grantedToTokenIdentifier ? { granted_to_token_identifier: args.grantedToTokenIdentifier } : {}),
        ...(args.grantedToClerkSubject ? { granted_to_clerk_subject: args.grantedToClerkSubject } : {}),
        ...(args.grantedToUserId ? { granted_to_user_id: args.grantedToUserId } : {}),
        ...(args.grantedToClerkOrgId ? { granted_to_clerk_org_id: args.grantedToClerkOrgId } : {}),
        ...(args.grantedToOrgId ? { granted_to_org_id: args.grantedToOrgId } : {}),
        ...(args.grantedToTeamId ? { granted_to_team_id: args.grantedToTeamId } : {}),
        ...(args.grantedToTeamPublicId ? { granted_to_team_public_id: args.grantedToTeamPublicId } : {}),
      })
    },
    async revokeSessionShare(
      auth: SignedControlPlaneAuth,
      args: {
        sessionId: string
        workspaceId: string
        grantId?: string
        grantedToTokenIdentifier?: string
        grantedToClerkSubject?: string
        grantedToUserId?: string
        grantedToClerkOrgId?: string
        grantedToOrgId?: string
        grantedToTeamId?: string
        grantedToTeamPublicId?: string
      },
    ) {
      return await requireExecutor(input, auth).mutation(convexApi.sessionShares.revoke, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        ...(args.grantId ? { grant_id: args.grantId as never } : {}),
        ...(args.grantedToTokenIdentifier ? { granted_to_token_identifier: args.grantedToTokenIdentifier } : {}),
        ...(args.grantedToClerkSubject ? { granted_to_clerk_subject: args.grantedToClerkSubject } : {}),
        ...(args.grantedToUserId ? { granted_to_user_id: args.grantedToUserId } : {}),
        ...(args.grantedToClerkOrgId ? { granted_to_clerk_org_id: args.grantedToClerkOrgId } : {}),
        ...(args.grantedToOrgId ? { granted_to_org_id: args.grantedToOrgId } : {}),
        ...(args.grantedToTeamId ? { granted_to_team_id: args.grantedToTeamId } : {}),
        ...(args.grantedToTeamPublicId ? { granted_to_team_public_id: args.grantedToTeamPublicId } : {}),
      }) as SessionShareRevokeResult
    },
    async listSessionShares(
      auth: SignedControlPlaneAuth,
      args: { sessionId: string; workspaceId: string },
    ) {
      return requireExecutor(input, auth).query(convexApi.sessionShares.list, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
      })
    },
    async listSessions(
      auth: SignedControlPlaneAuth,
      args: {
        workspaceId: string
      },
    ) {
      return requireExecutor(input, auth).query(convexApi.sessions.list, {
        workspace_id: args.workspaceId,
      })
    },
    async resolveSession(
      auth: SignedControlPlaneAuth,
      args: {
        sessionId: string
      },
    ) {
      return requireExecutor(input, auth).query(convexApi.sessions.resolve, {
        session_id: args.sessionId,
      })
    },
    async readSessionMessages(
      auth: SignedControlPlaneAuth,
      args: {
        sessionId: string
        workspaceId: string
        limit?: number
        before?: string
      },
    ) {
      if (args.before !== undefined && args.limit === undefined) {
        throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
      }
      if (args.limit !== undefined && (
        !Number.isSafeInteger(args.limit)
        || args.limit < 1
        || args.limit > MAX_MESSAGE_PAGE_LIMIT
      )) {
        throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
      }
      const body = await requireExecutor(input, auth).query(convexApi.sessions.readMessages, {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.before === undefined ? {} : { before_ordinal: decodeMessagePageCursor(args.sessionId, args.before) }),
      })
      if (!body || typeof body !== "object" || Array.isArray(body)) return body
      const result = body as Record<string, unknown>
      const nextOrdinal = result.next_ordinal
      if (typeof nextOrdinal !== "number") return body
      const { next_ordinal: _, ...rest } = result
      return {
        ...rest,
        nextCursor: encodeMessagePageCursor(args.sessionId, nextOrdinal),
      }
    },
    async syncSessionMessages(
      auth: SignedControlPlaneAuth,
      args: {
        sessionId: string
        workspaceId: string
        messages: unknown[]
        intakeReady?: boolean
        maxEventOrdinal?: number
      },
    ) {
      const body = {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
        messages: args.messages,
        intake_ready: args.intakeReady ?? false,
        ...(args.maxEventOrdinal === undefined ? {} : { max_event_ordinal: args.maxEventOrdinal }),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.sessions.syncMessagesForService,
          {
            ...serviceArgs(auth),
            ...body,
          },
        )
      }
      return requireExecutor(input, auth).mutation(convexApi.sessions.syncMessages, body)
    },
    async upsertSessionVisibility(
      auth: SignedControlPlaneAuth,
      args: {
        workspaceId: string
        sessions: SessionVisibility[]
      },
    ) {
      const body = {
        workspace_id: args.workspaceId,
        sessions: sessionVisibilityRows(args.sessions),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.sessions.upsertVisibilityForService,
          {
            ...serviceArgs(auth),
            ...body,
          },
        )
      }
      return requireExecutor(input, auth).mutation(convexApi.sessions.upsertVisibility, body)
    },
    async replaceSessionVisibility(
      auth: SignedControlPlaneAuth,
      args: {
        workspaceId: string
        sessions: SessionVisibility[]
      },
    ) {
      const body = {
        workspace_id: args.workspaceId,
        sessions: sessionVisibilityRows(args.sessions),
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.sessions.replaceVisibilityForService,
          {
            ...serviceArgs(auth),
            ...body,
          },
        )
      }
      return requireExecutor(input, auth).mutation(convexApi.sessions.replaceVisibility, body)
    },
    async deleteSessionVisibility(
      auth: SignedControlPlaneAuth,
      args: {
        sessionId: string
        workspaceId: string
      },
    ) {
      const body = {
        session_id: args.sessionId,
        workspace_id: args.workspaceId,
      }
      if (isCliAccessAuth(auth)) {
        return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.sessions.deleteVisibilityForService,
          {
            ...serviceArgs(auth),
            ...body,
          },
        )
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
