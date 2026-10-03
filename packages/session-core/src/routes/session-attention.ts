import type { SessionRouteContext, SessionRouteOptions } from "./session-route-options"
import { routeParam } from "@claxedo/helpers/route-param"
import { sessionOperationGuard } from "./session-operation-guard"
import { noStoreJson } from "./http"
import { errorBody } from "./error-body"

export async function sessionAttentionRoute(opts: SessionRouteOptions, c: SessionRouteContext): Promise<Response> {
  const sessionId = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, sessionId, "session_meta_read")
  if (guarded) return guarded
  const directory = await opts.resolveDirectory(c, { sessionId })
  const runtime = await opts.runtime(c)
  if (!await runtime.sessions.get(sessionId, directory)) return noStoreJson(c, errorBody("session_not_found", "Session not found"), 404)
  const afterText = c.req.query("after") ?? "0"
  const limitText = c.req.query("limit") ?? "256"
  const after = Number(afterText)
  const limit = Number(limitText)
  if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    return noStoreJson(c, errorBody("invalid_attention_query", "Attention after must be a nonnegative journal position and limit must be 1–256"), 400)
  }
  const row = await runtime.sessions.get(sessionId, directory)
  if (row?.attention && after > row.attention.sequence) return noStoreJson(c, errorBody("invalid_attention_cursor", "Attention cursor is ahead of the journal"), 409)
  return noStoreJson(c, await runtime.sessions.attention(sessionId, after, limit, directory))
}
