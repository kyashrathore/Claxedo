/**
 * WorkGraph fetch adapter for signed desktop AccountPort.
 *
 * Maps `/api/workgraph…` URLs onto named ops. Browser keeps authFetch / loopback.
 */
import { authFetch, getClaxedoServerUrl, unsignedLocalFetch, usesUnsignedLocalTransport } from "@/platform/api/api"
import { accountRun, parseHostedHttpError } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function hostedErrorResponse(error: unknown): Response {
  const hosted = parseHostedHttpError(error)
  if (hosted) return jsonResponse(hosted.body ?? { message: hosted.detail }, hosted.status)
  return jsonResponse(
    { error: { code: "request_failed", message: error instanceof Error ? error.message : String(error), retryable: false } },
    500,
  )
}

export function createWorkGraphAccountFetch(baseUrl: string = getClaxedoServerUrl()): typeof fetch {
  const fallback: typeof fetch = usesUnsignedLocalTransport(baseUrl) ? unsignedLocalFetch : authFetch

  return async (input, init) => {
    const run = accountRun()
    if (!run) return fallback(input, init)

    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
    const prefix = "/api/workgraph"
    if (!url.pathname.startsWith(prefix)) return fallback(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const relative = `${url.pathname.slice(prefix.length)}${url.search}`
    const subpath = relative.replace(/^\//, "") || ""

    try {
      if (method === "POST" && (subpath === "commands" || subpath.startsWith("commands?"))) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        return jsonResponse(decodeHostedResult(
          "workgraph.command",
          await run("workgraph.command", body),
        ))
      }
      if (method === "GET" && (subpath === "snapshot" || subpath.startsWith("snapshot?"))) {
        const params = new URLSearchParams(url.search)
        return jsonResponse(decodeHostedResult(
          "workgraph.snapshot",
          await run("workgraph.snapshot", {
            ...(params.get("limit") ? { limit: params.get("limit")! } : {}),
            ...(params.get("after") ? { after: params.get("after")! } : {}),
          }),
        ))
      }
      if (method === "GET") {
        return jsonResponse(decodeHostedResult(
          "workgraph.read",
          await run("workgraph.read", { subpath }),
        ))
      }
      if (method === "POST" || method === "PUT" || method === "DELETE") {
        const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        return jsonResponse(decodeHostedResult(
          "workgraph.write",
          await run("workgraph.write", { subpath, httpMethod: method, payload }),
        ))
      }
      throw new Error(`unsupported WorkGraph method ${method}`)
    } catch (error) {
      return hostedErrorResponse(error)
    }
  }
}
