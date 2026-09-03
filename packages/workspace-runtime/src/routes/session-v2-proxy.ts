import type { Context } from "hono"
import {
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessPolicy,
} from "../session-access-policy"
import { errorBody } from "./http"

type SessionV2ProxyOptions = {
  policy?: SessionAccessPolicy
  forward(c: Context): Promise<Response>
}

function sessionIdFromPath(path: string) {
  const match = path.match(/^\/api\/session\/([^/]+)(?:\/|$)/)
  if (!match || match[1] === "active") return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

function managedCreationUnavailable() {
  return Response.json(errorBody(
    "session_v2_managed_creation_unavailable",
    "Managed Session V2 creation must use the reserve/register session route",
  ), { status: 503 })
}

function managedForkUnavailable() {
  return Response.json(errorBody(
    "session_v2_managed_fork_unavailable",
    "Managed Session V2 fork must use the reserve/register session route",
  ), { status: 503 })
}

function managedPromptUnavailable() {
  return Response.json(errorBody(
    "session_v2_managed_prompt_unavailable",
    "Managed Session V2 prompts must use the fenced workspace session route",
  ), { status: 503 })
}

function invalidUpstreamResponse() {
  return Response.json(errorBody(
    "session_v2_invalid_response",
    "Session V2 returned a response that cannot be privacy-filtered",
  ), { status: 502 })
}

async function visibleSessionIds(
  policy: SessionAccessPolicy,
  c: Context,
  sessionIds: readonly string[],
  operation: "session_list" | "session_status",
) {
  return new Set(await policy.filterSessions({
    ...sessionAccessContext(c as never),
    operation,
    method: c.req.method,
    path: c.req.path,
    sessionIds,
  }))
}

function jsonResponse(value: unknown, upstream: Response) {
  const headers = new Headers(upstream.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("content-type", "application/json; charset=UTF-8")
  return new Response(JSON.stringify(value), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

async function filterListResponse(policy: SessionAccessPolicy, c: Context, upstream: Response) {
  const body = await upstream.clone().json().catch(() => undefined) as
    { data?: unknown; cursor?: unknown } | undefined
  if (!body || !Array.isArray(body.data)) return invalidUpstreamResponse()
  const rows = body.data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
  const ids = rows.map((item) => item.id).filter((id): id is string => typeof id === "string" && id.length > 0)
  const visible = await visibleSessionIds(policy, c, ids, "session_list")
  return jsonResponse({
    ...body,
    data: rows.filter((item) => typeof item.id === "string" && visible.has(item.id)),
  }, upstream)
}

async function filterActiveResponse(policy: SessionAccessPolicy, c: Context, upstream: Response) {
  const body = await upstream.clone().json().catch(() => undefined) as { data?: unknown } | undefined
  if (!body || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return invalidUpstreamResponse()
  }
  const entries = Object.entries(body.data as Record<string, unknown>)
  const visible = await visibleSessionIds(policy, c, entries.map(([id]) => id), "session_status")
  return jsonResponse({
    ...body,
    data: Object.fromEntries(entries.filter(([id]) => visible.has(id))),
  }, upstream)
}

/**
 * Privacy boundary for the raw Session V2 transport.
 *
 * The proxy cannot compensate a V2 create or fork today because that protocol
 * has no matching delete/fork lifecycle contract. Managed-private mode
 * therefore refuses those mutations before the upstream sees them. All other
 * session-scoped requests are admitted against their path session id, while
 * collection reads are filtered after the authoritative producer responds.
 */
export function sessionV2Proxy(options: SessionV2ProxyOptions) {
  return async (c: Context) => {
    const policy = options.policy
    if (!policy) return await options.forward(c)

    const path = c.req.path
    const method = c.req.method.toUpperCase()
    const managed = policy.sessionAuthority === "managed-private"
    const collection = path === "/api/session"
    const active = path === "/api/session/active"
    const fork = method === "POST" && /\/fork\/?$/.test(path)
    const prompt = method === "POST" && /\/prompt\/?$/.test(path)

    if (managed && collection && method === "POST") return managedCreationUnavailable()
    if (managed && fork) return managedForkUnavailable()
    if (managed && collection && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      return Response.json(errorBody(
        "session_v2_collection_mutation_forbidden",
        "Managed Session V2 collection mutations require an explicit lifecycle contract",
      ), { status: 403 })
    }
    if (managed && active && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      return Response.json(errorBody(
        "session_v2_active_mutation_forbidden",
        "The active-session collection is read-only",
      ), { status: 403 })
    }

    const sessionId = sessionIdFromPath(path)
    if (managed && path.startsWith("/api/session/") && !active && !sessionId) {
      return Response.json(errorBody(
        "session_v2_session_id_required",
        "Managed Session V2 routes require a valid session id",
      ), { status: 400 })
    }
    const decision = await policy.authorizePrefix({
      ...sessionAccessContext(c as never),
      operation: "session_v2_proxy",
      ...(sessionId ? { sessionId } : {}),
      method,
      path,
    })
    if (!decision.allowed) return sessionAccessDenied(decision)
    // The byte proxy cannot fence the upstream producer after durable lease
    // loss. Managed prompts therefore use session-core until V2 accepts the
    // same turn-admission/abort contract end to end.
    if (managed && prompt) return managedPromptUnavailable()

    const upstream = await options.forward(c)
    if (!managed || !upstream.ok || method === "HEAD") return upstream
    if (collection && method === "GET") return await filterListResponse(policy, c, upstream)
    if (active && method === "GET") return await filterActiveResponse(policy, c, upstream)
    return upstream
  }
}
