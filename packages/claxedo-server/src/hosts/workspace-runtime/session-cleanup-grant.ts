import { decodeJwt } from "jose"
import type { SessionCleanupGrant } from "@claxedo/mcp"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import { WORKSPACE_RUNTIME_SESSION_CLEANUP_GRANT } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { asRecord, parseJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { controlPlaneOrigin } from "./tasks-grant"

type Timer = ReturnType<typeof setTimeout>
type CleanupGrantOptions = { fetch?: (request: Request) => Promise<Response>; now?: () => number; requestTimeoutMs?: number }

function sessionCleanupGrantExpiry(token: string): number | undefined {
  try {
    const exp = decodeJwt(token).exp
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1_000 : undefined
  } catch {
    return undefined
  }
}

/** Renew the root's issuer proof and derive account access for each verified MCP session. */
export function workspaceRuntimeSessionCleanupGrant(env: NodeJS.ProcessEnv, options: CleanupGrantOptions = {}) {
  const initial = env[WORKSPACE_RUNTIME_SESSION_CLEANUP_GRANT]?.trim()
  const origin = controlPlaneOrigin(env)
  const initialExpiry = initial ? sessionCleanupGrantExpiry(initial) : undefined
  if (!initial || !origin || initialExpiry === undefined) return undefined
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000
  const lifetime = new AbortController()
  let token = initial
  let expiresAt = initialExpiry
  let withdrawn = false
  let stopped = false
  let running = false
  let timer: Timer | undefined
  let retryMs = 2_000
  const allowed = () => !stopped && !withdrawn && now() < expiresAt

  async function sendCleanupRequest(url: URL, init: RequestInit): Promise<Response> {
    init.signal?.throwIfAborted()
    const abandon = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, abandon.signal, ...(init.signal ? [init.signal] : [])])
    signal.throwIfAborted()
    const timeout = new DOMException("Session cleanup request exceeded its deadline", "TimeoutError")
    return settleAtRequestDeadline("session cleanup", { signal, deadlineAt: Date.now() + requestTimeoutMs }, (async () => {
      const response = await send(new Request(url, { ...init, signal, redirect: "manual" }))
      const body = await response.text()
      return new Response(body || null, { status: response.status, statusText: response.statusText, headers: response.headers })
    })(), () => abandon.abort(timeout), (_what, aborted) => aborted ? signal.reason : timeout)
  }

  function schedule(ms: number) {
    if (!running) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void renew() }, Math.max(0, ms))
    timer.unref?.()
  }

  async function renew() {
    if (!allowed()) return
    let response: Response | undefined
    try {
      response = await sendCleanupRequest(new URL("/api/claxedo/session-cleanup/grant/renew", origin), {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      })
    } catch {}
    if (response?.status === 401 || response?.status === 403) { withdrawn = true; return }
    const body = response?.ok ? parseJsonRecord(await response.text().catch(() => "")) : undefined
    const renewed = stringField(asRecord(body), "token")
    const expiry = renewed ? sessionCleanupGrantExpiry(renewed) : undefined
    if (renewed && expiry !== undefined && expiry > now()) {
      token = renewed
      expiresAt = expiry
      retryMs = 2_000
      schedule((expiresAt - now()) / 2)
      return
    }
    if (!allowed()) return
    schedule(Math.min(retryMs, expiresAt - now()))
    retryMs = Math.min(60_000, retryMs * 2)
  }

  function forSession(sessionId: string, credential: string): SessionCleanupGrant | undefined {
    if (!sessionId || !credential || !allowed()) return undefined
    let scoped: { token: string; expiresAt: number } | undefined
    let issuing: Promise<Response | undefined> | undefined
    async function issue() {
      const response = await sendCleanupRequest(new URL("/api/claxedo/session-cleanup/grant/session", origin), {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId, credential }),
      })
      if (!response.ok) return response
      const body = asRecord(await response.json().catch(() => undefined))
      const nextToken = stringField(body, "token")
      const nextExpiry = nextToken ? sessionCleanupGrantExpiry(nextToken) : undefined
      let originSession: unknown
      try { originSession = nextToken ? decodeJwt(nextToken).session_id : undefined } catch {}
      if (!nextToken || !nextExpiry || nextExpiry <= now() || originSession !== sessionId) {
        return Response.json({ error: { code: "session_cleanup_origin_invalid" } }, { status: 503 })
      }
      scoped = { token: nextToken, expiresAt: nextExpiry }
      return undefined
    }
    return { allowed, fetch: async (path, init) => {
      init?.signal?.throwIfAborted()
      if (!allowed()) return Response.json({ error: { code: "session_cleanup_grant_unavailable" } }, { status: 503 })
      const target = new URL(path, origin)
      if (target.origin !== origin || !(target.pathname === "/api/claxedo/session-cleanup" || target.pathname === "/api/claxedo/session-cleanup/delete")) {
        return Response.json({ error: { code: "session_cleanup_grant_scope" } }, { status: 403 })
      }
      if (!scoped || scoped.expiresAt - now() <= 60_000) {
        const pending = issuing ??= issue().finally(() => { issuing = undefined })
        const refusal = init?.signal
          ? await settleAtRequestDeadline("session cleanup issuance", { signal: init.signal, deadlineAt: Date.now() + requestTimeoutMs }, pending, () => {}, (_what, aborted) => aborted ? init.signal!.reason : new DOMException("Session cleanup issuance exceeded its deadline", "TimeoutError"))
          : await pending
        if (refusal) return refusal.clone()
      }
      if (!scoped) return Response.json({ error: { code: "session_cleanup_grant_unavailable" } }, { status: 503 })
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${scoped.token}`)
      return sendCleanupRequest(target, { ...init, headers })
    } }
  }
  return {
    forSession,
    start: () => { running = true; if (allowed()) schedule((expiresAt - now()) / 2) },
    stop: () => { stopped = true; running = false; lifetime.abort(new DOMException("The cleanup grant holder stopped", "AbortError")); if (timer) clearTimeout(timer); timer = undefined },
  }
}
