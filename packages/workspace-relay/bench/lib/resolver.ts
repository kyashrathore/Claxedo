// The bench resolver stands in for the control plane's /internal/relay
// resolver. The relay calls it to (a) resolve a workspace/host to a target
// base URL and (b) check RAT revocation. For the bench every workspace maps to
// one configured target and nothing is ever revoked. This is a real HTTP
// server the deployed relay talks to over the network exactly as it would talk
// to the control plane — no relay code path is stubbed.

import type { WorkspaceRelayTarget } from "../../src/server"

export type BenchResolverConfig = {
  // The upstream the relay should bridge to, e.g. the echo target or a Daytona
  // sandbox base URL. Every resolved workspace points here.
  targetBaseUrl: string
  // Bearer token the relay must present (CLAXEDO_RELAY_RESOLVER_TOKEN). When
  // unset the resolver accepts unauthenticated calls (local dev only).
  token?: string
  upstreamHeaders?: Record<string, string>
  // "cloud" (default, dial-out): relay dials targetBaseUrl. "user-hosted"
  // (dial-in): relay routes the client into the registered host tunnel and
  // never dials the target — targetBaseUrl/upstreamHeaders are unused on that
  // path (the sandbox agent reaches its own localhost).
  accessMode?: "cloud" | "user-hosted"
  port?: number
  hostname?: string
}

export type BenchResolver = {
  url: string
  port: number
  stop: () => void
}

export function startBenchResolver(config: BenchResolverConfig): BenchResolver {
  const hostname = config.hostname ?? "127.0.0.1"
  const server = Bun.serve({
    port: config.port ?? 0,
    hostname,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "bench-resolver" })
      }
      if (config.token) {
        const auth = request.headers.get("authorization")
        if (auth !== `Bearer ${config.token}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 })
        }
      }
      if (url.pathname.endsWith("/target")) {
        const workspaceId = url.searchParams.get("workspaceId") ?? "ws_bench"
        const hostId = url.searchParams.get("hostId") ?? "host_bench"
        const target: WorkspaceRelayTarget =
          config.accessMode === "user-hosted"
            ? {
                workspaceId,
                hostId,
                baseUrl: config.targetBaseUrl,
                access: "user-hosted",
                backing: "local-worktree",
              }
            : {
                workspaceId,
                hostId,
                baseUrl: config.targetBaseUrl,
                access: "cloud",
                backing: "cloud-vm",
                ...(config.upstreamHeaders ? { upstreamHeaders: config.upstreamHeaders } : {}),
              }
        return Response.json(target)
      }
      if (url.pathname.endsWith("/revocation")) {
        return Response.json({ active: true })
      }
      return Response.json({ error: "not_found" }, { status: 404 })
    },
  })
  const port = server.port ?? 0
  return {
    url: `http://${hostname}:${port}`,
    port,
    stop: () => server.stop(true),
  }
}
