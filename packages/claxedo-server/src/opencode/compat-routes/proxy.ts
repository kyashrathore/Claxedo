import type { ControlPlaneServices } from "../../authority/services"
import { OPENCODE_INTERNAL_BASE, opencodeRequest } from "../../opencode/engine"
import { resolveWorkspace } from "../../workspace/store"
import type { ControlPlaneRouteAuthOptions } from "../../platform/http/control-plane-route-auth"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { requestHarnessId, workspaceInput, type OpenCodeCompatRequestContext } from "./context"

// `ControlPlaneRouteAuthOptions` (`authConfig` + `verifier`) is part of the
// options on purpose: without it the mount site in server.ts had nowhere to put
// `...authRouteOptions(services)`, which is why this router was the one
// control-plane surface left with no per-route bearer verification at all.
export type OpenCodeCompatRouteOptions = ControlPlaneRouteAuthOptions & {
  env?: Record<string, string | undefined>
  onOpencodeAccess?: () => void
  services?: ControlPlaneServices
}

export function opencodeCompatDisabled(options?: OpenCodeCompatRouteOptions) {
  return options?.env?.CLAXEDO_DISABLE_OPENCODE_COMPAT === "1"
}

export async function proxyUpstream(
  c: OpenCodeCompatRequestContext & {
    req: OpenCodeCompatRequestContext["req"] & {
      url: string
      raw: Request
      method: string
    }
  },
  pathname: string,
  options?: OpenCodeCompatRouteOptions,
) {
  options?.onOpencodeAccess?.()
  const input = workspaceInput(c)
  const ws = await resolveWorkspace({
    workspaceId: input.workspaceId,
    directory: input.directory,
    create: !!input.directory,
  })
  // Build the request against the synthetic internal base; the injected
  // transport routes on path only (embedded) or rewrites the origin (URL mode).
  const url = new URL(pathname + new URL(c.req.url).search, OPENCODE_INTERNAL_BASE)
  const headers = new Headers(c.req.raw.headers)
  headers.delete("host")
  headers.delete("connection")
  if (ws) {
    headers.set("x-opencode-directory", ws.directory)
    headers.set("x-workspace-id", ws.id)
  }
  const init: RequestInit & { duplex: "half" } = {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    duplex: "half",
  }
  const req = new Request(url.toString(), init)

  const res = await fetchUpstream(req)
  const responseHeaders = new Headers(res.headers)
  // fetch() auto-decompresses the body, so strip encoding headers to avoid
  // the browser trying to decompress an already-decompressed body.
  responseHeaders.delete("content-encoding")
  responseHeaders.delete("content-length")
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
  })
}

export async function maybeProxy(
  c: Parameters<typeof proxyUpstream>[0],
  pathname: string,
  options?: OpenCodeCompatRouteOptions,
) {
  if (opencodeCompatDisabled(options)) return
  if (requestHarnessId(c) !== "opencode") return
  return proxyUpstream(c, pathname, options)
}

async function fetchUpstream(req: Request) {
  try {
    return await opencodeRequest(req)
  } catch (err) {
    if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND"].includes(causeCode(err) ?? "")) {
      return Response.json(errorBody("opencode_runtime_unavailable", "opencode runtime unavailable"), { status: 503 })
    }
    if (err && typeof err === "object" && (err as { code?: unknown }).code === "opencode_engine_unavailable") {
      return Response.json(
        errorBody("opencode_engine_unavailable", err instanceof Error ? err.message : String(err)),
        { status: 503 },
      )
    }
    throw err
  }
}

function causeCode(err: unknown) {
  const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined
  if (!cause || typeof cause !== "object") return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}
