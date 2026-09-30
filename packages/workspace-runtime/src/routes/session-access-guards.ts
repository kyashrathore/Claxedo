import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { sessionAccessContext, sessionAccessDenied, type SessionAccessOperation } from "../session-access-policy"
import { errorBody } from "./error-body"
import { managedSessionLifecycle, type SessionRouteContext as Ctx, type SessionRouteOptions as Opts } from "./session-route-options"
import type { SessionStatusSnapshot } from "./session-status-snapshot"

export async function sessionOperationGuard(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  operation: SessionAccessOperation,
) {
  const decision = await opts.sessionAccessPolicy?.authorize({
    ...sessionAccessContext(c),
    sessionId,
    operation,
    method: c.req.method,
    path: c.req.path,
  })
  if (decision && !decision.allowed) return sessionAccessDenied(decision)
  return opts.beforeSessionOperation?.(c, { sessionId, operation })
}

export async function sessionStartGuard(opts: Opts, c: Ctx, owner: AgentSessionStartBinding, operation: SessionAccessOperation, created = false) {
  const directory = await opts.resolveDirectory(c)
  if (owner.directory !== directory) return c.json(errorBody("session_start_not_found", "Session creation not found"), 404)
  if (created) return sessionOperationGuard(opts, c, owner.sessionId, operation)
  const context = sessionAccessContext(c)
  const policy = opts.sessionAccessPolicy
  const input = { ...context, operation, sessionId: owner.sessionId, registrationOperationId: owner.operationId, method: c.req.method, path: c.req.path }
  const decision = managedSessionLifecycle(opts, c)
    ? operation === "session_meta_read"
      ? await policy!.authorizeSessionStartStatus(input)
      : await policy!.authorizeSessionStart(input)
    : await policy?.authorize({ ...context, operation: "session_create", method: c.req.method, path: c.req.path })
  if (decision && !decision.allowed) return sessionAccessDenied(decision)
}

/**
 * The reservation a create claims, answered by the authority that owns the
 * session id before this runtime reads or writes anything under it.
 *
 * Permission to create a session in a workspace is not permission to touch one
 * that already exists in it. Only the operation that reserved the id may
 * create, retry or undo it, and the authority refuses an id held by someone
 * else without naming the session behind it — so a caller who guesses another
 * person's id learns nothing and changes nothing.
 */
export async function creationReservationGuard(opts: Opts, c: Ctx, sessionId: string, operationId: string) {
  if (!managedSessionLifecycle(opts, c)) return undefined
  const decision = await opts.sessionAccessPolicy!.authorizeSessionStart({
    ...sessionAccessContext(c),
    operation: "session_create",
    sessionId,
    registrationOperationId: operationId,
    method: c.req.method,
    path: c.req.path,
  })
  return decision.allowed ? undefined : sessionAccessDenied(decision)
}

export async function collectionSessionIds(
  opts: Opts,
  c: Ctx,
  operation: SessionAccessOperation,
  sessionIds: readonly string[],
) {
  if (!opts.sessionAccessPolicy) return new Set(sessionIds)
  return new Set(await opts.sessionAccessPolicy.filterSessions({
    ...sessionAccessContext(c),
    operation,
    method: c.req.method,
    path: c.req.path,
    sessionIds: [...new Set(sessionIds.filter(Boolean))],
  }))
}

export function explicitSessionId(input: unknown) {
  const row = asRecord(input)
  return typeof row?.sessionID === "string"
    ? row.sessionID
    : typeof row?.sessionId === "string"
      ? row.sessionId
      : ""
}

export function rowSessionId(input: unknown) {
  const row = asRecord(input)
  return explicitSessionId(row) || (typeof row?.id === "string" ? row.id : "")
}

export async function filterSessionRows<T>(opts: Opts, c: Ctx, operation: SessionAccessOperation, rows: T[]) {
  const allowed = await collectionSessionIds(opts, c, operation, rows.map(rowSessionId))
  return rows.filter((row) => allowed.has(rowSessionId(row)))
}

export async function filterSessionStatus(opts: Opts, c: Ctx, status: SessionStatusSnapshot) {
  const entries = Object.entries(status)
  const allowed = await collectionSessionIds(opts, c, "session_status", entries.map(([sessionId]) => sessionId))
  return Object.fromEntries(entries.filter(([sessionId]) => allowed.has(sessionId)))
}
