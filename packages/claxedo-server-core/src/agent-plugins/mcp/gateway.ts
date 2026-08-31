const REQUEST_HEADERS = new Set(["accept", "content-type", "last-event-id"])
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "retry-after"])

function protocolHeaders(source: Headers, fixed: ReadonlySet<string>) {
  const result = new Headers()
  for (const [name, value] of source) {
    if (fixed.has(name) || name.startsWith("mcp-")) result.set(name, value)
  }
  return result
}

export class McpGatewayError extends Error {
  constructor(
    readonly code: "invalid-resource" | "unsupported-method" | "upstream-redirect",
    message: string,
  ) {
    super(message)
    this.name = "McpGatewayError"
  }
}

function canonicalResource(value: string): URL | undefined {
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined
  return url
}

function supportedMethod(value: string): value is "GET" | "POST" | "DELETE" {
  return value === "GET" || value === "POST" || value === "DELETE"
}

/**
 * One-resource Streamable HTTP pass-through. It never follows a redirect,
 * retries a request, interprets JSON-RPC, or returns the upstream token.
 */
export async function forwardMcpGatewayRequest(input: {
  request: Request
  resource: string
  token: string
  tokenType: "bearer" | "basic"
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}) {
  const resource = canonicalResource(input.resource)
  if (!resource) throw new McpGatewayError("invalid-resource", "MCP Connection resource is invalid")
  if (!supportedMethod(input.request.method)) {
    throw new McpGatewayError("unsupported-method", `MCP gateway does not support ${input.request.method}`)
  }
  const headers = protocolHeaders(input.request.headers, REQUEST_HEADERS)
  headers.set("authorization", `${input.tokenType === "basic" ? "Basic" : "Bearer"} ${input.token}`)
  const upstream = await input.fetch(resource.toString(), {
    method: input.request.method,
    headers,
    redirect: "manual",
    ...(input.request.method === "GET" ? {} : { body: input.request.body, duplex: "half" } as RequestInit),
  })
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    upstream.body?.cancel().catch(() => {})
    throw new McpGatewayError("upstream-redirect", "MCP resource attempted to redirect an authenticated request")
  }
  const responseHeaders = protocolHeaders(upstream.headers, RESPONSE_HEADERS)
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}
