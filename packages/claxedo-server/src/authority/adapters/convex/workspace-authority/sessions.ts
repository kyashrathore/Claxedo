import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type {
  PrivateSessionAuthority,
  PrivateSessionRegistrationState,
  TransitionPrivateSessionRegistrationInput,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  SessionTurnConflictError,
  SessionTurnLeaseLostError,
  type SessionTurnAuthority,
  type SessionTurnLease,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { convexApi } from "./api"
import { requireAllowed, requireExecutor, requireServiceToken } from "./executor"
import type { ConvexAuthorityInput } from "./types"

const MESSAGE_PAGE_CURSOR_PREFIX = "cawmp1:"
const MAX_MESSAGE_PAGE_LIMIT = 500

export function sessionAuthority(input: ConvexAuthorityInput): PrivateSessionAuthority & SessionTurnAuthority & Pick<
  WorkspaceAuthority,
  "grantSessionShare" | "revokeSessionShare" | "listSessionShares"
> {
  const service = () => ({ service_token: requireServiceToken(input) })
  const transition = (
    fn: typeof convexApi.privateSessions.markRegistrationAmbiguous,
    value: TransitionPrivateSessionRegistrationInput,
  ) => requireExecutor(input, undefined, { allowUnsigned: true }).mutation(fn, {
    ...service(),
    principal_kind: value.principalKind,
    actor_id: value.actorId,
    actor_kind: value.actorKind,
    operation_id: value.operationId,
    session_id: value.sessionId,
    workspace_id: value.workspaceId,
    reason: value.reason,
  }) as Promise<{
    changed: boolean
    operationId: string
    sessionId: string
    workspaceId: string
    state: PrivateSessionRegistrationState
  }>

  return {
    async reserveSession(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.privateSessions.reserve, {
        operation_id: value.operationId,
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
        kind: value.kind,
        ...(value.parentSessionId ? { parent_session_id: value.parentSessionId } : {}),
        ...(value.title ? { title: value.title } : {}),
      }) as ReturnType<PrivateSessionAuthority["reserveSession"]>
    },
    async registerRuntimeSession(value) {
      return requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
        convexApi.privateSessions.registerRuntime,
        {
          ...service(),
          principal_kind: value.principalKind,
          actor_id: value.actorId,
          actor_kind: value.actorKind,
          operation_id: value.operationId,
          session_id: value.sessionId,
          workspace_id: value.workspaceId,
          ...(value.title ? { title: value.title } : {}),
        },
      )
    },
    markSessionRegistrationAmbiguous(value) {
      return transition(convexApi.privateSessions.markRegistrationAmbiguous, value)
    },
    beginSessionCompensation(value) {
      return transition(convexApi.privateSessions.beginCompensation, value)
    },
    completeSessionCompensation(value) {
      return transition(convexApi.privateSessions.completeCompensation, value)
    },
    async authorizeSessionRead(auth, value) {
      await requireAllowed(await requireExecutor(input, auth).query(convexApi.privateSessions.authorizeRead, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
      }))
    },
    async authorizeSessionWrite(auth, value) {
      await requireAllowed(await requireExecutor(input, auth).query(convexApi.privateSessions.authorizeWrite, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
      }))
    },
    async authorizeRuntimeSession(value) {
      await requireAllowed(await requireExecutor(input, undefined, { allowUnsigned: true }).query(
        convexApi.privateSessions.authorizeRuntime,
        {
          ...service(),
          principal_kind: value.principalKind,
          actor_id: value.actorId,
          actor_kind: value.actorKind,
          session_id: value.sessionId,
          workspace_id: value.workspaceId,
          action: value.action,
        },
      ))
    },
    async acquireSessionTurn(value) {
      try {
        const lease = await requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.privateSessions.acquireTurn,
          turnArgs(service(), value),
        ) as Omit<SessionTurnLease, "workspaceId">
        return { ...lease, workspaceId: value.workspaceId }
      } catch (error) {
        throw turnError(error, value.sessionId)
      }
    },
    async renewSessionTurn(value) {
      try {
        const lease = await requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.privateSessions.renewTurn,
          {
            ...turnArgs(service(), value),
            lease_id: value.leaseId,
            fencing_token: value.fencingToken,
          },
        ) as Omit<SessionTurnLease, "workspaceId">
        return { ...lease, workspaceId: value.workspaceId }
      } catch (error) {
        throw turnError(error, value.sessionId)
      }
    },
    async releaseSessionTurn(value) {
      try {
        return await requireExecutor(input, undefined, { allowUnsigned: true }).mutation(
          convexApi.privateSessions.releaseTurn,
          {
            ...turnArgs(service(), value),
            lease_id: value.leaseId,
            fencing_token: value.fencingToken,
          },
        ) as Awaited<ReturnType<SessionTurnAuthority["releaseSessionTurn"]>>
      } catch (error) {
        throw turnError(error, value.sessionId)
      }
    },
    async grantSessionParticipant(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.privateSessions.grantParticipant, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
        participant_actor_id: value.participantActorId,
      }) as Promise<{ participant_id: string }>
    },
    async revokeSessionParticipant(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.privateSessions.revokeParticipant, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
        participant_actor_id: value.participantActorId,
      }) as Promise<{ removed: boolean }>
    },
    async grantSessionShare(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.sessionShares.grant, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
        ...(value.grantedToTokenIdentifier ? { granted_to_token_identifier: value.grantedToTokenIdentifier } : {}),
        ...(value.grantedToClerkSubject ? { granted_to_clerk_subject: value.grantedToClerkSubject } : {}),
        ...(value.grantedToUserId ? { granted_to_user_id: value.grantedToUserId } : {}),
        ...(value.grantedToClerkOrgId ? { granted_to_clerk_org_id: value.grantedToClerkOrgId } : {}),
        ...(value.grantedToOrgId ? { granted_to_org_id: value.grantedToOrgId } : {}),
        ...(value.grantedToTeamId ? { granted_to_team_id: value.grantedToTeamId } : {}),
        ...(value.grantedToTeamPublicId ? { granted_to_team_public_id: value.grantedToTeamPublicId } : {}),
      })
    },
    async revokeSessionShare(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.sessionShares.revoke, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
        ...(value.grantId ? { grant_id: value.grantId as never } : {}),
        ...(value.grantedToTokenIdentifier ? { granted_to_token_identifier: value.grantedToTokenIdentifier } : {}),
        ...(value.grantedToClerkSubject ? { granted_to_clerk_subject: value.grantedToClerkSubject } : {}),
        ...(value.grantedToUserId ? { granted_to_user_id: value.grantedToUserId } : {}),
        ...(value.grantedToClerkOrgId ? { granted_to_clerk_org_id: value.grantedToClerkOrgId } : {}),
        ...(value.grantedToOrgId ? { granted_to_org_id: value.grantedToOrgId } : {}),
        ...(value.grantedToTeamId ? { granted_to_team_id: value.grantedToTeamId } : {}),
        ...(value.grantedToTeamPublicId ? { granted_to_team_public_id: value.grantedToTeamPublicId } : {}),
      }) as ReturnType<NonNullable<WorkspaceAuthority["revokeSessionShare"]>>
    },
    async listSessionShares(auth, value) {
      return requireExecutor(input, auth).query(convexApi.sessionShares.list, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
      }) as ReturnType<NonNullable<WorkspaceAuthority["listSessionShares"]>>
    },
    async listSessions(auth, value) {
      return requireExecutor(input, auth).query(convexApi.privateSessions.list, {
        workspace_id: value.workspaceId,
      }) as ReturnType<PrivateSessionAuthority["listSessions"]>
    },
    async resolveSession(auth, value) {
      return requireExecutor(input, auth).query(convexApi.privateSessions.resolve, { session_id: value.sessionId })
    },
    async readSessionMessages(auth, value) {
      validatePage(value.limit, value.before)
      const body = await requireExecutor(input, auth).query(convexApi.privateSessions.readMessages, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
        ...(value.limit === undefined ? {} : { limit: value.limit }),
        ...(value.before === undefined ? {} : { before_ordinal: decodeCursor(value.sessionId, value.before) }),
      })
      if (!body || typeof body !== "object" || Array.isArray(body)) return body
      const row = body as Record<string, unknown>
      if (typeof row.next_ordinal !== "number") return body
      const { next_ordinal: next, ...rest } = row
      return { ...rest, nextCursor: encodeCursor(value.sessionId, next) }
    },
    async syncSessionMessages(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.privateSessions.syncMessages, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
        messages: value.messages,
        intake_ready: value.intakeReady ?? false,
        ...(value.maxEventOrdinal === undefined ? {} : { max_event_ordinal: value.maxEventOrdinal }),
        ...(value.fencingToken === undefined ? {} : { fencing_token: value.fencingToken }),
      })
    },
    async upsertSessionVisibility(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.privateSessions.upsertVisibility, {
        workspace_id: value.workspaceId,
        sessions: visibilityRows(value.sessions),
      })
    },
    async replaceSessionVisibility(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.privateSessions.replaceVisibility, {
        workspace_id: value.workspaceId,
        sessions: visibilityRows(value.sessions),
      })
    },
    async deleteSessionVisibility(auth, value) {
      return requireExecutor(input, auth).mutation(convexApi.privateSessions.deleteVisibility, {
        session_id: value.sessionId,
        workspace_id: value.workspaceId,
      })
    },
  }
}

function turnArgs(
  service: { service_token: string },
  value: { principalKind: "user" | "service"; actorId: string; actorKind: "human" | "agent"; sessionId: string; workspaceId: string; turnId: string },
) {
  return {
    ...service,
    principal_kind: value.principalKind,
    actor_id: value.actorId,
    actor_kind: value.actorKind,
    session_id: value.sessionId,
    workspace_id: value.workspaceId,
    turn_id: value.turnId,
  }
}

function turnError(error: unknown, sessionId: string) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("session_turn_lease_lost")) return new SessionTurnLeaseLostError(sessionId)
  const conflict = message.match(/session_turn_in_progress:(\d+)/)
  if (conflict) return new SessionTurnConflictError(sessionId, Number(conflict[1]))
  return error
}

function visibilityRows(rows: Array<{ sessionId: string; title?: string; createdAt?: number; updatedAt?: number }>) {
  return rows.map((row) => ({
    session_id: row.sessionId,
    ...(row.title ? { title: row.title } : {}),
    ...(row.createdAt === undefined ? {} : { created_at: row.createdAt }),
    ...(row.updatedAt === undefined ? {} : { updated_at: row.updatedAt }),
  }))
}

function validatePage(limit?: number, before?: string) {
  if (before !== undefined && limit === undefined) throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_LIMIT)) {
    throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
  }
}

function encodeCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ sessionId, ordinal })).toString("base64url")}`
}

function decodeCursor(sessionId: string, value: string) {
  try {
    if (!value.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error()
    const parsed = JSON.parse(Buffer.from(value.slice(MESSAGE_PAGE_CURSOR_PREFIX.length), "base64url").toString("utf8")) as {
      sessionId?: unknown
      ordinal?: unknown
    }
    if (parsed.sessionId !== sessionId || !Number.isSafeInteger(parsed.ordinal) || Number(parsed.ordinal) < 0) throw new Error()
    return Number(parsed.ordinal)
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}
