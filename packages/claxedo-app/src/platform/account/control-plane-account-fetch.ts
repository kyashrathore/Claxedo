/**
 * Control-plane fetch adapter for signed desktop AccountPort.
 *
 * Maps known `/api/control/...` URLs onto named ops. Relay/runtime paths
 * (post-mint) must not go through this — callers keep their existing transport
 * for those.
 */
import { authFetch } from "@/platform/api/api"
import { accountRun, parseHostedHttpError } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import type { HostedOperationName } from "@/platform/account/account-port"

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
    { error: { message: error instanceof Error ? error.message : String(error) } },
    500,
  )
}

async function runOp(name: HostedOperationName, input: Record<string, unknown>) {
  const run = accountRun()
  if (!run) throw new Error("account bridge unavailable")
  return decodeHostedResult(name, await run(name, input))
}

function queryRecord(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) out[key] = value
  return out
}

async function readJsonBody(init?: RequestInit): Promise<Record<string, unknown>> {
  if (!init?.body) return {}
  try {
    return JSON.parse(String(init.body)) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function createControlPlaneAccountFetch(fallback: typeof fetch = authFetch): typeof fetch {
  return async (input, init) => {
    const run = accountRun()
    if (!run) return fallback(input, init)

    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
    if (!url.pathname.startsWith("/api/control/")) return fallback(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    try {
      if (method === "POST" && url.pathname === "/api/control/sessions") {
        const body = await readJsonBody(init)
        return jsonResponse(await runOp("session.create", body))
      }

      if (method === "GET" && url.pathname === "/api/control/session-list") {
        return jsonResponse(await runOp("session.navigationList", queryRecord(url)))
      }

      const messages = /^\/api\/control\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
      if (messages && method === "GET") {
        return jsonResponse(await runOp("session.messages", {
          sessionId: decodeURIComponent(messages[1]!),
          ...queryRecord(url),
        }))
      }

      const gateway = /^\/api\/control\/sessions\/([^/]+)\/gateway$/.exec(url.pathname)
      if (gateway && method === "GET") {
        return jsonResponse(await runOp("session.gateway", {
          sessionId: decodeURIComponent(gateway[1]!),
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
      if (projection && method === "POST") {
        const action = projection[3] as "register" | "checkpoint" | "repair"
        const body = await readJsonBody(init)
        const opName = (
          action === "register"
            ? "session.projection.register"
            : action === "checkpoint"
              ? "session.projection.checkpoint"
              : "session.projection.repair"
        ) as HostedOperationName
        return jsonResponse(await runOp(opName, {
          workspaceId: decodeURIComponent(projection[1]!),
          sessionId: decodeURIComponent(projection[2]!),
          ...body,
        }))
      }

      return fallback(input, init)
    } catch (error) {
      return hostedErrorResponse(error)
    }
  }
}
