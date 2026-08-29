/**
 * Agent-config extensions fetch adapter for signed desktop AccountPort.
 *
 * Maps `/api/claxedo/agent-config/extensions*` onto named read/write ops.
 */
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { accountRun, parseHostedHttpError } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import type { HostedOperationName } from "@/platform/account/account-port"

const PREFIX = "/api/claxedo/agent-config/extensions"

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

export function createAgentConfigAccountFetch(
  fallback: typeof fetch = authFetch,
  baseUrl: string = getClaxedoServerUrl(),
): typeof fetch {
  return async (input, init) => {
    const run = accountRun()
    if (!run) return fallback(input, init)

    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, baseUrl)
    if (!url.pathname.startsWith(PREFIX)) return fallback(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const subpath = url.pathname.slice(PREFIX.length).replace(/^\//, "")
    const query = queryRecord(url)
    try {
      if (method === "GET") {
        return jsonResponse(await runOp("agentConfig.extensions.read", {
          subpath,
          ...query,
        }))
      }
      if (method === "POST" || method === "PUT" || method === "DELETE") {
        const rawBody = init?.body ? String(init.body) : ""
        const payload = rawBody
          ? JSON.parse(rawBody) as Record<string, unknown>
          : {}
        return jsonResponse(await runOp("agentConfig.extensions.write", {
          subpath,
          httpMethod: method,
          payload,
          ...query,
        }))
      }
      return fallback(input, init)
    } catch (error) {
      return hostedErrorResponse(error)
    }
  }
}
