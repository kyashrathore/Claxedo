/**
 * This machine's inbound route beside the relay tunnel: one TLS port on each
 * private-network address, serving the surface the tunnel replays onto
 * (`hostServingSurface` over the runtime listener) for HTTP and WebSocket.
 *
 * It decides no access itself; the runtime admits the owner's Runtime Access
 * Token. It does let through only a bearer shaped as one, so the runtime's
 * other bearers (a harness's, a terminal hook's) never meet the network, and
 * it drops the relay's marker, so a Relay Host Token cannot be replayed around
 * the relay.
 */

import { createServer, type Server } from "node:https"
import type { IncomingMessage } from "node:http"
import os from "node:os"
import type { Duplex } from "node:stream"
import { Hono } from "hono"
import { getRequestListener } from "@hono/node-server"
import { decodeJwt } from "jose"
import { bearerToken, isPrivateNetworkAddress, parseIpAddress } from "@claxedo/helpers"
import { loopbackReplayHeaders } from "@claxedo/server-core/platform/http/peer-address"
import type { DirectTlsIdentity } from "./direct-certificate"
import type { HostRuntimeListener } from "./runtime"
import { hostServingSurface } from "./surface"

export type DirectRoutes = { port: number; addresses: string[]; spkiSha256: string }

export type DirectListener = {
  /** Re-reads this machine's addresses, opening and closing listeners for the difference, and answers what a beat reports. */
  routes: () => Promise<DirectRoutes | undefined>
  /**
   * While withheld (the owner paused this machine) every request is refused
   * and every socket already carried to a runtime is closed, as a pause closes
   * the relay tunnels; the addresses stay bound, so a resume needs no new route.
   */
  withhold: (withheld: boolean) => void
  close: () => Promise<void>
}

export type DirectListenerOptions = {
  identity: DirectTlsIdentity
  runtime: Pick<HostRuntimeListener, "url" | "fetch" | "upgrade">
  /** The port to keep; one that is taken is replaced and reported through `onPort`. */
  port?: number
  onPort?: (port: number) => void
  addresses?: () => string[]
  log?: (line: string) => void
}

const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."
const RELAY_ONLY_HEADERS = ["x-forwarded-by", "x-claxedo-embedded-relay-host-auth", "x-workspace-id"] as const
const WORKSPACE_ROUTE = /^\/workspaces\/([^/]+)(\/.*)?$/

export function privateNetworkAddresses(interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const found = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const ip = entry.internal ? undefined : parseIpAddress(entry.address)
      if (ip && isPrivateNetworkAddress(ip)) found.add(entry.address)
    }
  }
  return [...found].sort()
}

function isRuntimeAccessToken(token: string | undefined): token is string {
  if (!token) return false
  try {
    const claims = decodeJwt(token)
    return claims.iss === "claxedo-control-plane" && claims.aud === "workspace-relay"
  } catch {
    return false
  }
}

/** A browser cannot set a header on a socket, so its token rides as a subprotocol; any other client sends the bearer. */
function upgradeBearer(request: IncomingMessage): string | undefined {
  const header = request.headers["sec-websocket-protocol"]
  const offered = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((item) => item.trim())
  return bearerToken(request.headers.authorization)
    ?? offered.find((item) => item.startsWith(RUNTIME_ACCESS_TOKEN_PROTOCOL))?.slice(RUNTIME_ACCESS_TOKEN_PROTOCOL.length)
}

type Routed = { kind: "routed"; target: URL; workspaceId: string; token: string } | { kind: "refused"; status: 401 | 404; code: string }

function routeDirectRequest(rawUrl: string, token: string | undefined, localBaseUrl: string): Routed {
  const url = new URL(rawUrl, "https://direct.invalid")
  const match = WORKSPACE_ROUTE.exec(url.pathname)
  if (!isRuntimeAccessToken(token)) return { kind: "refused", status: 401, code: "direct_route_token_required" }
  let workspaceId: string
  try {
    workspaceId = decodeURIComponent(match?.[1] ?? "")
  } catch {
    return { kind: "refused", status: 404, code: "direct_route_not_found" }
  }
  if (!workspaceId) return { kind: "refused", status: 404, code: "direct_route_not_found" }
  const target = hostServingSurface({ localBaseUrl, workspaceId, path: `${match?.[2] ?? "/"}${url.search}` })
  if (target.kind === "deny") return { kind: "refused", status: 404, code: "direct_route_not_found" }
  return { kind: "routed", target: target.url, workspaceId, token }
}

function forwardedHeaders(headers: Headers, routed: Extract<Routed, { kind: "routed" }>): Headers {
  const kept = new Headers(loopbackReplayHeaders(Object.fromEntries(headers)))
  for (const name of RELAY_ONLY_HEADERS) kept.delete(name)
  kept.set("x-workspace-id", routed.workspaceId)
  kept.set("authorization", `Bearer ${routed.token}`)
  return kept
}

function directRefusal(status: 401 | 404, code: string) {
  return Response.json({ error: { code, message: "This route is not served to that caller" } }, { status })
}

type Gate = { withheld: boolean; carried: Set<Duplex> }

function pausedRefusal() {
  return Response.json({ error: { code: "machine_paused", message: "The owner paused this machine" } }, { status: 503 })
}

function requestApp(runtime: DirectListenerOptions["runtime"], gate: Gate) {
  const app = new Hono()
  app.all("*", async (c) => {
    if (gate.withheld) return pausedRefusal()
    const request = c.req.raw
    const routed = routeDirectRequest(request.url, bearerToken(request.headers.get("authorization") ?? undefined), runtime.url)
    if (routed.kind === "refused") return directRefusal(routed.status, routed.code)
    const bodyless = request.method === "GET" || request.method === "HEAD"
    return await runtime.fetch(new Request(routed.target, {
      method: request.method,
      headers: forwardedHeaders(request.headers, routed),
      ...(bodyless ? {} : { body: request.body, duplex: "half" }),
      signal: request.signal,
    }))
  })
  return app
}

function upgradeHandler(runtime: DirectListenerOptions["runtime"], gate: Gate) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (gate.withheld) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      return
    }
    const routed = routeDirectRequest(request.url ?? "/", upgradeBearer(request), runtime.url)
    if (routed.kind === "refused") {
      socket.end(`HTTP/1.1 ${routed.status} ${routed.status === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const headers = forwardedHeaders(new Headers(Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value] as [string, string]])), routed)
    request.headers = Object.fromEntries(headers)
    request.url = `${routed.target.pathname}${routed.target.search}`
    gate.carried.add(socket)
    socket.once("close", () => gate.carried.delete(socket))
    runtime.upgrade(request, socket, head)
  }
}

function listenOn(server: Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, address, () => {
      server.off("error", reject)
      const bound = server.address()
      if (!bound || typeof bound === "string") reject(new Error("direct listener did not bind a TCP port"))
      else resolve(bound.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

export function startDirectListener(options: DirectListenerOptions): DirectListener {
  const gate: Gate = { withheld: false, carried: new Set() }
  const listener = getRequestListener(requestApp(options.runtime, gate).fetch)
  const upgrade = upgradeHandler(options.runtime, gate)
  const servers = new Map<string, Server>()
  const log = options.log ?? (() => undefined)
  let port = options.port

  const open = async (address: string) => {
    const server = createServer({ key: options.identity.keyPem, cert: options.identity.certPem, minVersion: "TLSv1.3" }, listener)
    server.keepAliveTimeout = 30_000
    server.on("upgrade", upgrade)
    try {
      const bound = await listenOn(server, port ?? 0, address).catch(async (error: unknown) => {
        if (port === undefined || servers.size > 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
        log(`direct route: port ${port} is taken; choosing another`)
        return await listenOn(server, 0, address)
      })
      if (bound !== port) options.onPort?.(bound)
      port = bound
      servers.set(address, server)
      log(`direct route: serving ${address.includes(":") ? `[${address}]` : address}:${bound}`)
    } catch (error) {
      log(`direct route: ${address} could not be served: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    routes: async () => {
      const wanted = new Set((options.addresses ?? privateNetworkAddresses)())
      for (const [address, server] of servers) {
        if (wanted.has(address)) continue
        servers.delete(address)
        await closeServer(server)
        log(`direct route: ${address} is gone; stopped listening on it`)
      }
      for (const address of wanted) if (!servers.has(address)) await open(address)
      if (servers.size === 0 || port === undefined) return undefined
      return { port, addresses: [...servers.keys()].sort(), spkiSha256: options.identity.spkiSha256 }
    },
    withhold: (withheld) => {
      gate.withheld = withheld
      if (!withheld) return
      for (const socket of gate.carried) socket.destroy()
      gate.carried.clear()
    },
    close: async () => {
      const closing = [...servers.values()]
      servers.clear()
      await Promise.all(closing.map(closeServer))
    },
  }
}
