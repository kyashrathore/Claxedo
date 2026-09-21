import type { Context } from "hono"
import { SESSION_STREAM_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { eventSessionId, type CompatEnvelope } from "../compat-events"
import type { WorkspaceRuntimeEvent } from "../bus"
import {
  sessionAccessContext,
  sessionAccessDenied,
  sessionRequestProvenance,
  type SessionAccessPolicy,
  type SessionAccessPolicyInput,
} from "../session-access-policy"

export type SessionEventScope =
  | { managed: false; grant?: undefined }
  | { managed: false; grant: "workspace"; lease: string; expiresAt: number }
  | { managed: true; sessionId: string; lease: string; expiresAt: number }

export function isSessionEventScopeResponse(
  value: SessionEventScope | Response,
): value is Response {
  // `instanceof Response` is not stable across fetch implementations/realms.
  // The scope is our own discriminated value, so identify it by its canonical
  // discriminator and treat every other return as the HTTP denial response.
  return !("managed" in value)
}

/** The refusal code of the unscoped `wr/events` arm; the reader reopens `?sessionID=` on it and on nothing else. */
export const WORKSPACE_EVENT_STREAM_DENIED = "workspace_event_stream_denied"
/** The refusal code of the session-scoped arm (the runtime's own 403); the reader holds the target until the route names another session. */
export const SESSION_EVENT_STREAM_DENIED = "session_event_stream_denied"


/**
 * Who is asking decides the scope of a managed runtime's event stream.
 *
 * A principal the authority admits to the workspace opens it unscoped; the
 * stream then carries every session-less frame (pty, process) and, session by
 * session, what the session authority grants that principal. A share grantee
 * holds no workspace access, only a grant on one session, so the stream is a
 * session resource for them: the session id is supplied by the caller and
 * admitted through the same verified relay identity and authority oracle as
 * the REST session routes, under a renewable lease.
 *
 * Both arms are for a relay-replayed reader. A loopback-direct one is the
 * machine's own user, who is every local session's owner, and reads the broad
 * stream whatever the policy was composed with — as does a runtime with no
 * managed policy at all.
 */
export async function authorizeSessionEventScope(
  c: Context,
  policy: SessionAccessPolicy | undefined,
): Promise<SessionEventScope | Response> {
  if (policy?.sessionAuthority !== "managed-private") return { managed: false }
  if (sessionRequestProvenance(c) === "loopback-direct") return { managed: false }

  const sessionId = c.req.query("sessionID")?.trim()
  if (!sessionId) {
    if (!policy.authorizeHost) {
      return Response.json({
        error: {
          code: "session_event_scope_required",
          message: "Managed private event streams require sessionID",
        },
      }, { status: 400 })
    }
    const workspace = await policy.authorizeHost({
      ...sessionAccessContext(c),
      operation: "session_event_stream",
      minimumRole: "viewer",
      method: c.req.method,
      path: c.req.path,
    })
    if (workspace.allowed) {
      const now = Date.now()
      if (!workspace.lease?.trim() || workspace.expiresAt === undefined || !Number.isFinite(workspace.expiresAt) || workspace.expiresAt <= now) {
        return Response.json({ error: {
          code: "session_stream_authority_invalid_response",
          message: "Workspace authority returned an invalid stream lease",
        } }, { status: 503 })
      }
      return {
        managed: false,
        grant: "workspace",
        lease: workspace.lease,
        expiresAt: Math.min(workspace.expiresAt, now + SESSION_STREAM_LEASE_TTL_MS),
      }
    }
    // A refusal at workspace level is the reader's cue to reopen for one
    // session under a lease; it is named as such so a 403 minted elsewhere on
    // the path (the relay, the token mint) is not mistaken for it.
    if (workspace.status === 403) {
      return Response.json({
        error: { code: WORKSPACE_EVENT_STREAM_DENIED, message: workspace.message, cause: workspace.code },
      }, { status: 403 })
    }
    return sessionAccessDenied(workspace)
  }

  if (!policy.authorizeStream) {
    return Response.json({
      error: {
        code: "session_stream_authority_required",
        message: "Managed private event streams require renewable session authority",
      },
    }, { status: 503 })
  }

  const access = sessionAccessContext(c)
  const input = {
    ...access,
    operation: "session_event_stream",
    sessionId,
    method: c.req.method,
    path: c.req.path,
    signal: c.req.raw.signal,
  } satisfies SessionAccessPolicyInput & { sessionId: string }
  const decision = await policy.authorizeStream(input)
  if (!decision.allowed) {
    // Named like the unscoped arm's refusal: a 403 minted elsewhere on the
    // path is an outage the reader retries, this one it acts on.
    if (decision.status === 403) {
      return Response.json({ error: { code: SESSION_EVENT_STREAM_DENIED, message: decision.message, cause: decision.code } }, { status: 403 })
    }
    return sessionAccessDenied(decision)
  }
  const now = Date.now()
  if (!decision.lease.trim() || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= now) {
    return Response.json({
      error: {
        code: "session_stream_authority_invalid_response",
        message: "Session authority returned an invalid stream lease",
      },
    }, { status: 503 })
  }

  // The request's own host token expires within a minute; the delivery
  // policy renews the session on this lease, never on the token.
  return {
    managed: true,
    sessionId,
    lease: decision.lease,
    // Never let control-plane/runtime clock skew extend a lease beyond the
    // frozen local security bound. An earlier signed expiry still wins.
    expiresAt: Math.min(decision.expiresAt, now + SESSION_STREAM_LEASE_TTL_MS),
  }
}

export function compatEnvelopeSessionId(event: CompatEnvelope) {
  return eventSessionId(event.payload)
}

/**
 * The session a control frame belongs to. A pty bound to a session (its
 * bytes, its exit) is that session's: a reader without a grant on the session
 * must not see the terminal the agent drove. A pty bound to none is the
 * workspace's.
 */
export function workspaceRuntimeEventSessionId(event: WorkspaceRuntimeEvent): string | undefined {
  switch (event.type) {
    case "agent.lifecycle":
      return event.sessionId
    case "session.lifecycle":
      return event.sessionID
    case "pty.created":
    case "pty.updated":
      return event.info.sessionId
    case "pty.exited":
    case "pty.deleted":
    case "pty.stream":
      return event.sessionId
    default:
      return undefined
  }
}
