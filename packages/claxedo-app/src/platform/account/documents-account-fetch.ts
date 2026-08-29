/**
 * Documents HTTP adapter for signed desktop AccountPort.
 * Maps known /documents routes onto named ops; falls back to authFetch.
 */
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
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

export function createDocumentsAccountFetch(baseUrl: string = getClaxedoServerUrl()): typeof fetch {
  return async (input, init) => {
    const run = accountRun()
    if (!run) return authFetch(input, init)

    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, baseUrl)
    if (!url.pathname.startsWith("/documents")) return authFetch(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const parts = url.pathname.split("/").filter(Boolean) // documents, ...
    try {
      const workSource = parts.length === 3 && parts[2] === "work-source" && method === "POST"
      if (workSource) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        return jsonResponse(await runOp("documents.workSource", {
          id: decodeURIComponent(parts[1]!),
          ...body,
        }))
      }
      const pin = parts.length === 5 && parts[2] === "snapshots" && parts[4] === "work-source-pin" && method === "POST"
      if (pin) {
        return jsonResponse(await runOp("documents.workSourcePin", {
          id: decodeURIComponent(parts[1]!),
          snapshotId: decodeURIComponent(parts[3]!),
        }))
      }
      // Unmapped document routes stay on authFetch for browser/unsigned only.
      return authFetch(input, init)
    } catch (error) {
      return hostedErrorResponse(error)
    }
  }
}
