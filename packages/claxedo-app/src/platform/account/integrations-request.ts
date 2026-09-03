/**
 * Hosted integrations (/api/claxedo/integrations) dual-path.
 *
 * Signed desktop: named AccountPort ops (renderer has no bearer).
 * Browser / unsigned: authFetch against the configured control-plane origin.
 *
 * Returns a `ConnectionsRequest`-shaped function so existing connect/list
 * stores keep their Response-based contract (including 409 connect conflicts).
 */
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { hostedControlCall, parseHostedHttpError, signedAccountRun } from "@/platform/account/hosted-control-call"
import type { HostedOperationName } from "@/platform/account/account-port"

/** Path is relative to the /api/claxedo/integrations mount ("" for the root list). */
export type ConnectionsRequest = (path: string, init?: RequestInit) => Promise<Response>

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
    { message: error instanceof Error ? error.message : String(error) },
    500,
  )
}

async function runOp(name: HostedOperationName, input: Record<string, unknown> = {}) {
  return await hostedControlCall(name, input, async () => {
    throw new Error("account bridge unavailable")
  })
}

/**
 * Path is relative to `/api/claxedo/integrations` ("" for the catalog root).
 */
export function createIntegrationsRequest(baseUrl: string = getClaxedoServerUrl()): ConnectionsRequest {
  const fallback: ConnectionsRequest = (path, init) =>
    authFetch(new URL(`/api/claxedo/integrations${path}`, baseUrl).toString(), init)

  return async (path, init) => {
    if (!await signedAccountRun()) return fallback(path, init)

    const method = (init?.method ?? "GET").toUpperCase()
    try {
      if ((path === "" || path === "/") && method === "GET") {
        return jsonResponse(await runOp("connections.list"))
      }

      const connect = /^\/([^/]+)\/connect$/.exec(path)
      if (connect && method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        return jsonResponse(await runOp("connections.connect", {
          id: decodeURIComponent(connect[1]!),
          ...body,
        }))
      }

      const attempt = /^\/attempts\/([^/]+)$/.exec(path)
      if (attempt && method === "GET") {
        return jsonResponse(await runOp("connections.attempt", {
          state: decodeURIComponent(attempt[1]!),
        }))
      }

      const repositories = /^\/connections\/([^/]+)\/repositories$/.exec(path)
      if (repositories && method === "GET") {
        return jsonResponse(await runOp("connections.repositories", {
          id: decodeURIComponent(repositories[1]!),
        }))
      }

      const reverify = /^\/connections\/([^/]+)\/reverify$/.exec(path)
      if (reverify && method === "POST") {
        return jsonResponse(await runOp("connections.reverify", {
          id: decodeURIComponent(reverify[1]!),
        }))
      }

      const disconnect = /^\/connections\/([^/]+)$/.exec(path)
      if (disconnect && method === "DELETE") {
        return jsonResponse(await runOp("connections.disconnect", {
          id: decodeURIComponent(disconnect[1]!),
        }))
      }

      throw new Error(`no hosted integrations operation for ${method} ${path}`)
    } catch (error) {
      return hostedErrorResponse(error)
    }
  }
}
