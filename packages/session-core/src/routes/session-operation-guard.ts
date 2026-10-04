import { sessionAccessContext, sessionAccessDenied, type SessionAccessOperation } from "../session-access-policy"
import type { SessionRouteContext as Ctx, SessionRouteOptions as Opts } from "./session-route-options"

export async function sessionOperationGuard(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  operation: SessionAccessOperation,
  registrationOperationId?: string,
) {
  const decision = await opts.sessionAccessPolicy?.authorize({
    ...sessionAccessContext(c),
    sessionId,
    operation,
    ...(registrationOperationId ? { registrationOperationId } : {}),
    method: c.req.method,
    path: c.req.path,
  })
  if (decision && !decision.allowed) return sessionAccessDenied(decision)
  return opts.beforeSessionOperation?.(c, { sessionId, operation })
}

/**
 * Whether this reader may prompt the session, answered by the same policy the
 * prompt route asks and reported alongside the harness's capabilities.
 *
 * A `follow` share admits the transcript and refuses the turn, so the reader
 * reaches this route and not `POST /session/:id/message`. Without the answer
 * here the composer has only the workspace role to go on, which says nothing
 * about a session someone was shared, and the reader meets the refusal as a
 * 403 after typing.
 */
export async function sessionPromptAdmitted(opts: Opts, c: Ctx, sessionId: string) {
  const decision = await opts.sessionAccessPolicy?.authorize({
    ...sessionAccessContext(c),
    sessionId,
    operation: "prompt",
  })
  return decision?.allowed !== false
}
