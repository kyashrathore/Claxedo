/**
 * The loopback origin this machine's agents send model calls to, in front of
 * every row the control plane built from the owner's accounts. Per call it
 * sends the call to the owner's desktop broker while the desktop's channel
 * offers the call's provider (`owner-broker-channel.ts`), and to the row's own
 * hosted binding otherwise, so a route change never changes a row and never
 * restarts a harness.
 *
 * A desktop's answer is the answer, refusals included: a call the desktop
 * refused is not sent again to the hosted broker. Only a call that found no
 * channel to go out on goes to the hosted broker instead; one whose channel
 * broke after it was sent fails once, and the client's retry finds the
 * hosted broker.
 *
 * A caller must present the stand-in its row carries, as the hosted broker
 * requires, so a process on this machine that was handed no row spends
 * nothing through the desktop either.
 */

import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import { getRequestListener } from "@hono/node-server"
import { OWNER_BROKER_PROVIDER_PREFIX } from "./owner-broker-wire"
import type { OwnerBrokerChannels } from "./owner-broker-channel"

const ROUTE = /^\/routes\/([a-f0-9]{24})(\/[^?]*)?$/
/** Stand-ins a harness may still hold for one route: the latest and those it replaced, until each expires. */
const HELD_STAND_INS = 4
const NOT_FORWARDED_REQUEST = ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "expect", "te", "proxy-authorization", "proxy-connection"]
/** `fetch` has decoded the body, so the upstream's encoding and length describe bytes this answer no longer carries. */
const NOT_FORWARDED_RESPONSE = ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]

export type FrontedRow = { providerId: string; baseUrl: string; placeholder: string; expiresAt?: number }

export type OwnerBrokerShim = {
  url: string
  /** The loopback base URL a built row is spent at; the row's own base URL is where its calls go when no desktop serves them. */
  front: (row: FrontedRow) => string
  close: () => Promise<void>
}

type Route = { providerId: string; upstream: string; standIns: Map<string, number> }

function shimRefusal(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

function presentedStandIn(headers: Headers): string | undefined {
  const authorization = headers.get("authorization")
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7)
  return headers.get("x-api-key") ?? headers.get("x-goog-api-key") ?? undefined
}

function frontedRouteKey(row: FrontedRow) {
  return createHash("sha256").update(JSON.stringify([row.providerId, row.baseUrl])).digest("hex").slice(0, 24)
}

function headersWithout(headers: Headers, names: readonly string[]) {
  const kept = new Headers(headers)
  for (const name of names) kept.delete(name)
  return kept
}

async function hosted(route: Route, rest: string, request: Request, send: typeof fetch): Promise<Response> {
  const bodyless = request.method === "GET" || request.method === "HEAD"
  try {
    const answer = await send(`${route.upstream}${rest}`, {
      method: request.method,
      headers: headersWithout(request.headers, NOT_FORWARDED_REQUEST),
      ...(bodyless ? {} : { body: request.body, duplex: "half" }),
      redirect: "manual",
      signal: request.signal,
    } as RequestInit)
    return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: headersWithout(answer.headers, NOT_FORWARDED_RESPONSE) })
  } catch {
    return shimRefusal(502, "upstream_unavailable", "The hosted broker could not be reached")
  }
}

function bindShim(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      const bound = server.address()
      if (!bound || typeof bound === "string") reject(new Error("the owner broker shim did not bind a TCP port"))
      else resolve(bound.port)
    })
  })
}

export async function startOwnerBrokerShim(options: {
  channels: Pick<OwnerBrokerChannels, "offers" | "forward">
  /** The port to keep, so a row's base URL survives a restart; one that is taken is replaced and reported through `onPort`. */
  port?: number
  onPort?: (port: number) => void
  fetch?: typeof fetch
  now?: () => number
}): Promise<OwnerBrokerShim> {
  const now = options.now ?? Date.now
  const send = options.fetch ?? fetch
  const routes = new Map<string, Route>()

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const match = ROUTE.exec(url.pathname)
    const route = match ? routes.get(match[1]) : undefined
    if (!match || !route) return shimRefusal(404, "binding_route_required", "No row is spent at this address")
    const standIn = presentedStandIn(request.headers)
    const until = standIn === undefined ? undefined : route.standIns.get(standIn)
    if (until === undefined || until <= now()) return shimRefusal(401, "runtime_token_invalid", "The stand-in this row carries is required")
    if (request.headers.has("upgrade")) return shimRefusal(403, "request_outside_policy", "A socket cannot carry a brokered call")
    const path = `${match[2] ?? "/"}${url.search}`
    if (options.channels.offers(route.providerId)) {
      try {
        const answer = await options.channels.forward({
          method: request.method,
          path: `${OWNER_BROKER_PROVIDER_PREFIX}${encodeURIComponent(route.providerId)}${path}`,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
          signal: request.signal,
        })
        if (answer) return answer
      } catch {
        return shimRefusal(502, "owner_broker_unreachable", "The owner's desktop stopped answering mid-call")
      }
    }
    return await hosted(route, path, request, send)
  }

  const server = createServer(getRequestListener(handle))
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
  })
  const port = await bindShim(server, options.port ?? 0).catch(async (error: unknown) => {
    const taken = error instanceof Error && "code" in error && error.code === "EADDRINUSE"
    if (options.port === undefined || !taken) throw error
    return await bindShim(server, 0)
  })
  if (port !== options.port) options.onPort?.(port)
  const url = `http://127.0.0.1:${port}`

  return {
    url,
    front: (row) => {
      const key = frontedRouteKey(row)
      const route = routes.get(key) ?? { providerId: row.providerId, upstream: row.baseUrl, standIns: new Map<string, number>() }
      routes.set(key, route)
      route.standIns.delete(row.placeholder)
      route.standIns.set(row.placeholder, row.expiresAt ?? Number.POSITIVE_INFINITY)
      for (const [standIn, until] of route.standIns) if (until <= now()) route.standIns.delete(standIn)
      while (route.standIns.size > HELD_STAND_INS) route.standIns.delete(route.standIns.keys().next().value!)
      return `${url}/routes/${key}`
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
