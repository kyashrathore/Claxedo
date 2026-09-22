import type { CredentialBrokerErrorCode } from "@claxedo/agent-runtime-contract"
import { sameRuntime, type BindingAuthority, type BindingFailure, type RuntimeIdentity } from "./binding.js"
import { brokerErrorBody } from "./errors.js"
import type { RuntimeTokenClaims } from "./token.js"

export type BrokerOptions = {
  authority: BindingAuthority
  verifyToken(token: string): Promise<RuntimeTokenClaims | undefined>
  fetch?: typeof fetch
  /** Ceiling on one authority round-trip — resolve, currentRuntime, markUsed, reportFailure. */
  authorityTimeoutMs?: number
  /**
   * Ceiling on reaching the vendor's response headers, and on how long a
   * queued request waits for a lane before it is refused. A streamed body is
   * not under this clock: SSE answers run longer than any sane header deadline
   * and stay bounded by the lane they keep and by the caller going away.
   */
  upstreamTimeoutMs?: number
  /** Upstream exchanges in flight at once, counted from authority resolution until the body is spent. */
  maxConcurrentUpstream?: number
}

const DEFAULT_AUTHORITY_TIMEOUT_MS = 10_000
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000
const DEFAULT_MAX_CONCURRENT_UPSTREAM = 32

/**
 * The headers a harness's own SDK puts an API key in, and therefore the
 * placeholder. `Authorization: Bearer` is handled beside them; a vendor whose
 * client sends the key somewhere else needs its name added here before a
 * binding for it can work.
 */
const API_KEY_HEADERS = ["x-api-key", "x-goog-api-key"] as const

/**
 * The query names a credential is commonly written into. A vendor that acts on
 * one declares it on its binding and has the request refused instead; these
 * come off the forwarded query because a key left in a URL reaches the
 * vendor's access log and every proxy in between even where nothing reads it.
 * The query otherwise belongs to the caller.
 */
const CREDENTIAL_QUERY_PARAMS = ["key", "access_token", "api_key", "apikey"] as const

/**
 * What a vendor's answer may carry back to the harness.
 *
 * An allow-list, because what must not travel is open-ended: vendors echo the
 * account they billed (`openai-organization`), the key slot they read, a
 * `www-authenticate` challenge naming the operator's tenant, a session cookie.
 * The SDKs a turn runs on read content negotiation, retry timing, rate-limit
 * budgets, the id their support asks for, and Connect's status pair; the rest
 * is the vendor's business with an account the sandbox cannot see.
 *
 * `content-length` is absent deliberately: `fetch` has decoded the body, so the
 * upstream's length describes bytes the broker no longer sends.
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control", "content-language", "content-type", "date", "etag", "last-modified", "vary",
  "request-id", "retry-after", "retry-after-ms", "x-request-id", "x-should-retry",
  "grpc-status", "grpc-message", "grpc-status-details-bin",
])

/** Rate-limit budgets, whose individual names are per-vendor but whose prefixes are not. */
const FORWARDED_RESPONSE_HEADER_PREFIXES = ["ratelimit-", "x-ratelimit-", "anthropic-ratelimit-"]

function forwardedResponseHeaders(upstream: Headers) {
  const headers = new Headers()
  for (const [name, value] of upstream) {
    if (FORWARDED_RESPONSE_HEADERS.has(name) || FORWARDED_RESPONSE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      headers.set(name, value)
    }
  }
  return headers
}

function brokerErrorResponse(status: number, code: CredentialBrokerErrorCode) {
  return Response.json(brokerErrorBody(code), { status })
}

function stripTransportHeaders(headers: Headers) {
  for (const named of (headers.get("connection") ?? "").split(",")) {
    if (named.trim()) headers.delete(named.trim())
  }
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]) headers.delete(name)
}

function once(run: () => void): () => void {
  let ran = false
  return () => {
    if (!ran) {
      ran = true
      run()
    }
  }
}

/**
 * Settled work raced against a clock. The work keeps running after a timeout
 * — a hung authority cannot be un-hung from here — but the caller, and the
 * lane it holds, stop waiting on it.
 */
function stopWaitingAfter<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out")), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * A counted budget of simultaneous upstream exchanges. A lane is taken before
 * the authority is asked and handed back when the upstream body is spent,
 * refused, or the caller leaves — work under the broker's roof has a ceiling
 * even when the caller never cancels.
 */
function concurrencyGate(max: number) {
  let inFlight = 0
  type Waiter = { tryGrant(lane: () => void): boolean }
  const queue: Waiter[] = []
  const release = () => {
    let next = queue.shift()
    while (next) {
      if (next.tryGrant(once(release))) return
      next = queue.shift()
    }
    inFlight -= 1
  }
  function enter(signal: AbortSignal, waitMs: number): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (inFlight < max) {
      inFlight += 1
      return Promise.resolve(once(release))
    }
    return new Promise<() => void>((grant, refuse) => {
      let settled = false
      const settle = (act: () => void): boolean => {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        const at = queue.indexOf(waiter)
        if (at >= 0) queue.splice(at, 1)
        act()
        return true
      }
      const waiter: Waiter = { tryGrant: (lane) => settle(() => grant(lane)) }
      const timer = setTimeout(() => settle(() => refuse(new Error("Broker saturated"))), waitMs)
      const onAbort = () => settle(() => refuse(signal.reason))
      signal.addEventListener("abort", onAbort, { once: true })
      queue.push(waiter)
    })
  }
  return { enter }
}

function deadlineWithCallerAbort(timeoutMs: number, signal: AbortSignal) {
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal.reason)
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out", "TimeoutError")),
    timeoutMs,
  )
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener("abort", abortFromCaller, { once: true })
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal.removeEventListener("abort", abortFromCaller)
    },
  }
}

/**
 * The lane a forwarded answer still holds: an upstream body keeps its slot
 * until the harness finishes it or goes away, so a vendor that sends headers
 * and then drips forever cannot be multiplied past the budget.
 */
function laneBody(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
        } else controller.enqueue(value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      release()
      await reader.cancel(reason).catch(() => {})
    },
  })
}

export function createEgressBroker(options: BrokerOptions) {
  const authorityTimeoutMs = options.authorityTimeoutMs ?? DEFAULT_AUTHORITY_TIMEOUT_MS
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  const lane = concurrencyGate(options.maxConcurrentUpstream ?? DEFAULT_MAX_CONCURRENT_UPSTREAM)
  const authority: BindingAuthority = {
    resolve: (bindingId) => stopWaitingAfter(options.authority.resolve(bindingId), authorityTimeoutMs),
    currentRuntime: (identity: RuntimeIdentity) => stopWaitingAfter(options.authority.currentRuntime(identity), authorityTimeoutMs),
    markUsed: (bindingId) => stopWaitingAfter(options.authority.markUsed(bindingId), authorityTimeoutMs),
    reportFailure: (failure: BindingFailure) => stopWaitingAfter(options.authority.reportFailure(failure), authorityTimeoutMs),
  }
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const route = /^\/bindings\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname)
    if (!route) return brokerErrorResponse(404, "binding_route_required")
    const authorization = request.headers.get("authorization")
    // A scheme the broker does not serve is still a credential presentation:
    // beside a keyed header it is a second identity, and alone it is no token.
    if (authorization !== null && !authorization.startsWith("Bearer ")) {
      return brokerErrorResponse(401, "runtime_token_required")
    }
    const keyed = API_KEY_HEADERS.map((name) => request.headers.get(name)).filter((value): value is string => value !== null)
    const token = authorization?.slice(7) ?? keyed[0]
    // Two different values mean the caller is presenting two identities and the
    // binding would be spent under whichever one this happened to pick.
    if (!token || keyed.some((value) => value !== token)) {
      return brokerErrorResponse(401, "runtime_token_required")
    }
    const claims = await options.verifyToken(token)
    if (!claims) return brokerErrorResponse(401, "runtime_token_invalid")
    const bindingId = route[1]
    if (!claims.bindingIds.includes(bindingId)) return brokerErrorResponse(403, "binding_not_permitted")
    let release: () => void
    try {
      release = await lane.enter(request.signal, upstreamTimeoutMs)
    } catch {
      return brokerErrorResponse(503, "broker_authority_unavailable")
    }
    let forwarded = false
    try {
      const resolved = await authority.resolve(bindingId)
      if (!resolved) return brokerErrorResponse(403, "binding_unavailable")
      const { binding, value } = resolved
      if (binding.id !== bindingId || binding.status !== "active" || !sameRuntime(binding, claims)
        || !await authority.currentRuntime(claims)) return brokerErrorResponse(403, "binding_unavailable")
      if (!Number.isSafeInteger(binding.revision) || binding.revision < 1 || !value) return brokerErrorResponse(503, "credential_unavailable")
      const origin = new URL(binding.destination.origin)
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
        return brokerErrorResponse(503, "binding_destination_invalid")
      }
      const pathname = route[2] ?? "/"
      // Encoded separators and dot segments can be decoded differently by upstream routers.
      if (/%(?:2f|5c|2e|25)/i.test(pathname) || pathname.includes("\\")) return brokerErrorResponse(403, "request_outside_policy")
      const allowedPath = binding.destination.pathPrefixes.some((prefix) => prefix.startsWith("/")
        && (pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)))
      if (!binding.destination.methods.includes(request.method) || !allowedPath) return brokerErrorResponse(403, "request_outside_policy")
      // The binding's own account is injected at the header this vendor reads.
      // A caller that also fills a slot the vendor honours is presenting a
      // second identity, and deleting it quietly would leave the harness
      // reading the operator's account as the one the vendor refused.
      const querySlots = binding.destination.credentialQuerySlots ?? []
      if (querySlots.some((name) => url.searchParams.has(name))) return brokerErrorResponse(403, "request_outside_policy")
      const target = new URL(origin)
      target.pathname = pathname
      target.search = url.search
      for (const name of CREDENTIAL_QUERY_PARAMS) target.searchParams.delete(name)
      const headers = new Headers(request.headers)
      stripTransportHeaders(headers)
      const injection = binding.injection
      const injected = [injection.header, ...Object.keys(injection.headers ?? {})]
      // Every name this binding owns, stripped before anything is set: a
      // companion the row declares but has no value for must not survive from
      // the client either.
      for (const name of ["authorization", ...API_KEY_HEADERS, "cookie", ...injected]) {
        headers.delete(name)
      }
      if (injected.some((name) => ["host", "connection", "content-length", "transfer-encoding", "cookie"].includes(name.toLowerCase()))) {
        return brokerErrorResponse(503, "binding_injection_invalid")
      }
      headers.set(injection.header, injection.scheme ? `${injection.scheme} ${value}` : value)
      for (const [name, companion] of Object.entries(injection.headers ?? {})) {
        if (name.toLowerCase() === injection.header.toLowerCase()) return brokerErrorResponse(503, "binding_injection_invalid")
        if (companion !== null) headers.set(name, companion)
      }
      await authority.markUsed(bindingId)
      let upstream: Response
      const deadline = deadlineWithCallerAbort(upstreamTimeoutMs, request.signal)
      try {
        upstream = await (options.fetch ?? fetch)(target, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          signal: deadline.signal,
          redirect: "manual",
          duplex: "half",
        } as RequestInit)
      } catch {
        return brokerErrorResponse(502, "upstream_unavailable")
      } finally {
        deadline.cleanup()
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel()
        return brokerErrorResponse(502, "upstream_redirect_refused")
      }
      if (upstream.status === 401 || upstream.status === 403) {
        try {
          await authority.reportFailure({ bindingId, credentialId: binding.credentialId, revision: binding.revision, status: upstream.status })
        } catch (error) {
          await upstream.body?.cancel()
          throw error
        }
      }
      const responseHeaders = forwardedResponseHeaders(upstream.headers)
      const body = upstream.body
      if (body) {
        forwarded = true
        return new Response(laneBody(body, release), { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
      }
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
    } catch {
      return brokerErrorResponse(503, "broker_authority_unavailable")
    } finally {
      if (!forwarded) release()
    }
  }
}
