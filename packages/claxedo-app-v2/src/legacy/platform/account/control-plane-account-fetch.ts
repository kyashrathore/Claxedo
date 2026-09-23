/**
 * Control-plane fetch adapter for signed desktop AccountPort.
 *
 * Maps known `/api/control/...` URLs onto named ops. Relay/runtime paths
 * (post-mint) must not go through this — callers keep their existing transport
 * for those.
 */
import { authFetch } from "@/platform/api/api"
import { hostedControlCall, parseHostedHttpError, signedAccountRun } from "@/platform/account/hosted-control-call"
import type { HostedOperationName } from "@/platform/account/account-port"
import { recordOrEmpty } from "@/lib/record"
import { errorMessage } from "@/lib/server-errors"

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
    { error: { message: errorMessage(error) } },
    500,
  )
}

async function runOp(name: HostedOperationName, input: Record<string, unknown>) {
  return await hostedControlCall(name, input, async () => {
    throw new Error("account bridge unavailable")
  })
}

function queryRecord(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) out[key] = value
  return out
}

/** The three projection verbs the route pattern above can match. */
function projectionAction(value: string | undefined) {
  return value === "register" || value === "checkpoint" || value === "repair" ? value : undefined
}

async function readJsonBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  const source = input instanceof Request ? input.clone() : input
  const request = new Request(source, init)
  if (!request.body) return {}
  try {
    return recordOrEmpty(await request.json())
  } catch {
    return {}
  }
}

export function createControlPlaneAccountFetch(fallback: typeof fetch = authFetch): typeof fetch {
  return async (input, init) => {
    const run = await signedAccountRun()
    if (!run) return fallback(input, init)

    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
    if (!url.pathname.startsWith("/api/control/")) return fallback(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    try {
      if (method === "POST" && url.pathname === "/api/control/sessions") {
        const body = await readJsonBody(input, init)
        return jsonResponse(await runOp("session.create", body))
      }

      if (method === "GET" && url.pathname === "/api/control/session-list") {
        return jsonResponse(await runOp("session.navigationList", queryRecord(url)))
      }

      const messages = /^\/api\/control\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
      if (messages && method === "GET") {
        return jsonResponse(await runOp("session.messages", {
          sessionId: decodeURIComponent(messages[1]),
          ...queryRecord(url),
        }))
      }

      const gateway = /^\/api\/control\/sessions\/([^/]+)\/gateway$/.exec(url.pathname)
      if (gateway && method === "GET") {
        return jsonResponse(await runOp("session.gateway", {
          sessionId: decodeURIComponent(gateway[1]),
          ...queryRecord(url),
        }))
      }

      const list = url.pathname === "/api/control/sessions" && method === "GET"
      if (list) {
        return jsonResponse(await runOp("session.list", queryRecord(url)))
      }

      const projection = /^\/api\/control\/workspaces\/([^/]+)\/sessions\/([^/]+)\/(register|checkpoint|repair)$/.exec(
        url.pathname,
      )
      const action = projection ? projectionAction(projection[3]) : undefined
      if (projection && action && method === "POST") {
        const body = await readJsonBody(input, init)
        const opName = action === "register"
          ? "session.projection.register"
          : action === "checkpoint"
            ? "session.projection.checkpoint"
            : "session.projection.repair"
        return jsonResponse(await runOp(opName, {
          workspaceId: decodeURIComponent(projection[1]),
          sessionId: decodeURIComponent(projection[2]),
          ...body,
        }))
      }

      return fallback(input, init)
    } catch (error) {
      return hostedErrorResponse(error)
    }
  }
}
