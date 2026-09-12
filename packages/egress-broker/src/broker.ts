import { sameRuntime, type BindingAuthority } from "./binding.js"
import type { RuntimeTokenClaims } from "./token.js"

export type BrokerOptions = {
  authority: BindingAuthority
  verifyToken(token: string): Promise<RuntimeTokenClaims | undefined>
  fetch?: typeof fetch
}

function brokerErrorResponse(status: number, error: string) {
  return Response.json({ error }, { status })
}

function stripTransportHeaders(headers: Headers) {
  for (const named of (headers.get("connection") ?? "").split(",")) {
    if (named.trim()) headers.delete(named.trim())
  }
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]) headers.delete(name)
}

export function createEgressBroker(options: BrokerOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const route = /^\/bindings\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname)
    if (!route) return brokerErrorResponse(404, "binding_route_required")
    const authorization = request.headers.get("authorization")
    const apiKey = request.headers.get("x-api-key")
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : apiKey
    if (!token || (apiKey && authorization && apiKey !== token)) return brokerErrorResponse(401, "runtime_token_required")
    const claims = await options.verifyToken(token)
    if (!claims) return brokerErrorResponse(401, "runtime_token_invalid")
    const bindingId = route[1]
    if (!claims.bindingIds.includes(bindingId)) return brokerErrorResponse(403, "binding_not_permitted")
    try {
      const resolved = await options.authority.resolve(bindingId)
      if (!resolved) return brokerErrorResponse(403, "binding_unavailable")
      const { binding, value } = resolved
      if (binding.id !== bindingId || binding.status !== "active" || !sameRuntime(binding, claims)
        || !await options.authority.currentRuntime(claims)) return brokerErrorResponse(403, "binding_unavailable")
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
      const target = new URL(origin)
      target.pathname = pathname
      target.search = url.search
      const headers = new Headers(request.headers)
      stripTransportHeaders(headers)
      for (const name of ["authorization", "x-api-key", "cookie", "x-claxedo-egress-target"]) headers.delete(name)
      const injection = binding.injection
      if (["host", "connection", "content-length", "transfer-encoding", "cookie"].includes(injection.header.toLowerCase())) {
        return brokerErrorResponse(503, "binding_injection_invalid")
      }
      headers.set(injection.header, injection.scheme ? `${injection.scheme} ${value}` : value)
      let upstream: Response
      try {
        upstream = await (options.fetch ?? fetch)(target, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          signal: request.signal,
          redirect: "manual",
          duplex: "half",
        } as RequestInit)
      } catch {
        return brokerErrorResponse(502, "upstream_unavailable")
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel()
        return brokerErrorResponse(502, "upstream_redirect_refused")
      }
      if (upstream.status === 401 || upstream.status === 403) {
        try {
          await options.authority.reportFailure({ bindingId, credentialId: binding.credentialId, revision: binding.revision, status: upstream.status })
        } catch (error) {
          await upstream.body?.cancel()
          throw error
        }
      }
      const responseHeaders = new Headers(upstream.headers)
      stripTransportHeaders(responseHeaders)
      // `fetch` has already decoded the body, so forwarding the upstream's
      // `content-encoding` labels plaintext as gzip and the client fails
      // decoding it (`Z_DATA_ERROR: incorrect header check`).
      for (const name of [injection.header, "authorization", "x-api-key", "set-cookie", "content-encoding"]) responseHeaders.delete(name)
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
    } catch {
      return brokerErrorResponse(503, "broker_authority_unavailable")
    }
  }
}
