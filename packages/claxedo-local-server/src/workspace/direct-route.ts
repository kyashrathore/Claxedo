/**
 * The desktop's route to another machine on its own network, beside the
 * relay. The renderer cannot take it itself: its `connect-src` names exact
 * origins, the machine's runtime sends no CORS headers, and only Node can pin
 * the machine's key. So the renderer registers the routes a workspace's
 * connection named and sends that workspace's runtime traffic here with the
 * runtime access token it would give the relay, and this daemon carries it
 * over TLS to the machine, pinning the key the machine reported.
 *
 * When no reported address answers, the refusal is `direct_route_unavailable`
 * (503), answered before anything was sent, and the renderer sends that
 * request through the relay. A request that fails after it was sent is that
 * request's failure, not a cue to send it twice.
 *
 * Each machine it reaches with the owner's token is handed to the owner
 * broker dialer (`owner-broker-dialer.ts`), which serves that machine this
 * desktop's broker for as long as the route is carried.
 */

import type { EventEmitter } from "node:events"
import { IncomingMessage, request as httpRequest, STATUS_CODES, type ClientRequest, type IncomingHttpHeaders } from "node:http"
import os from "node:os"
import type { Duplex } from "node:stream"
import type { TLSSocket } from "node:tls"
import type { Context, Hono } from "hono"
import { z } from "zod"
import { bearerToken, isPrivateNetworkAddress, parseIpAddress, type IpAddress } from "@claxedo/helpers"
import { DirectRouteUnreachable, PinnedAgent, pinnedConnection, type DirectTarget } from "./direct-connection"
import type { OwnerBrokerDialer } from "./owner-broker-dialer"

export const DIRECT_ROUTE_UNAVAILABLE = "direct_route_unavailable"
const DIRECT_PATH = /^\/direct\/workspaces\/([^/?]+)(\/[^?]*)?/
const PROBE_TIMEOUT_MS = 1_500
const CONNECT_TIMEOUT_MS = 3_000
const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."
const NOT_FORWARDED = new Set([
  "host", "connection", "keep-alive", "upgrade", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "origin", "referer", "cookie", "authorization", "forwarded", "x-claxedo-daemon-capability",
  "sec-websocket-protocol",
])

const routesBody = z.object({
  port: z.number().int().min(1).max(65_535),
  addresses: z.array(z.string().refine((value) => {
    const ip = parseIpAddress(value)
    return ip !== undefined && isPrivateNetworkAddress(ip)
  })).min(1).max(16),
  spkiSha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict()

type DirectRoutes = z.infer<typeof routesBody>
type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>
type PendingUpgrade = { target: DirectTarget; token: string; path: string }

function interfaceSignature(interfaces: NetworkInterfaces): string {
  return Object.values(interfaces).flatMap((entries) => (entries ?? []).filter((entry) => !entry.internal).map((entry) => entry.cidr ?? entry.address)).sort().join(",")
}

function samePrefix(a: IpAddress, b: IpAddress, bits: number): boolean {
  if (a.kind === "v4" && b.kind === "v4") return bits === 0 || ((a.value ^ b.value) >>> (32 - bits)) === 0
  if (a.kind !== "v6" || b.kind !== "v6") return false
  for (let bit = 0; bit < bits; bit += 16) {
    const mask = bits - bit >= 16 ? 0xffff : (0xffff << (16 - (bits - bit))) & 0xffff
    if ((a.segments[bit / 16] & mask) !== (b.segments[bit / 16] & mask)) return false
  }
  return true
}

/** Lower is tried first: an address on one of this machine's own subnets, then the LAN's, then unique-local, then a tailnet's CGNAT. */
function addressRank(address: string, interfaces: NetworkInterfaces): number {
  const ip = parseIpAddress(address)
  if (!ip) return 9
  const local = Object.values(interfaces).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal && entry.cidr)
  if (local.some((entry) => {
    const [base, bits] = (entry.cidr ?? "").split("/")
    const parsed = parseIpAddress(base)
    return parsed !== undefined && samePrefix(ip, parsed, Number(bits))
  })) return 0
  if (ip.kind === "v6") return 2
  return (ip.value >>> 22) === 0x64400000 >>> 22 ? 3 : 1
}

function directRouteRefusal(code: string, status: 401 | 404 | 502 | 503, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

const unavailable = () => directRouteRefusal(DIRECT_ROUTE_UNAVAILABLE, 503, "No address this machine reported answered")

function outboundHeaders(headers: Headers | IncomingHttpHeaders, target: DirectTarget, token: string): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value ?? ""] as const)
  const kept = Object.fromEntries(entries.filter(([name]) => !NOT_FORWARDED.has(name.toLowerCase()) && !name.toLowerCase().startsWith("x-forwarded-")))
  return { ...kept, host: `${target.address.includes(":") ? `[${target.address}]` : target.address}:${target.port}`, authorization: `Bearer ${token}` }
}

function offeredRuntimeAccessToken(header: string | undefined): string | undefined {
  return header?.split(",").map((item) => item.trim()).find((item) => item.startsWith(RUNTIME_ACCESS_TOKEN_PROTOCOL))?.slice(RUNTIME_ACCESS_TOKEN_PROTOCOL.length)
}

function bodyOf(answer: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      answer.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 0) <= 0) answer.pause()
      })
      answer.once("end", () => controller.close())
      answer.once("error", (error) => controller.error(error))
    },
    pull: () => {
      answer.resume()
    },
    cancel: () => {
      answer.destroy()
    },
  })
}

async function sendBody(body: ReadableStream<Uint8Array>, upstream: ClientRequest) {
  const reader = body.getReader()
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    if (!upstream.write(chunk.value)) await new Promise((drained) => upstream.once("drain", drained))
  }
  upstream.end()
}

function webResponse(answer: IncomingMessage, method: string): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(answer.headers)) {
    if (value === undefined || ["connection", "keep-alive", "transfer-encoding"].includes(name)) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const status = answer.statusCode ?? 502
  const bodyless = method === "HEAD" || [204, 205, 304].includes(status)
  if (bodyless) answer.resume()
  return new Response(bodyless ? null : bodyOf(answer), { status, headers })
}

function refuseUpgrade(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function switchHead(answer: IncomingMessage, offeredToken: string | undefined): string {
  const lines = answer.rawHeaders.reduce<string[]>((all, item, index, raw) => (index % 2 === 0 ? [...all, `${item}: ${raw[index + 1]}`] : all), [])
  const selected = answer.headers["sec-websocket-protocol"]
  const echoed = !selected && offeredToken ? [`Sec-WebSocket-Protocol: ${RUNTIME_ACCESS_TOKEN_PROTOCOL}${offeredToken}`] : []
  return `HTTP/1.1 101 Switching Protocols\r\n${[...lines, ...echoed].join("\r\n")}\r\n\r\n`
}

function splice(client: Duplex, clientHead: Buffer, machine: Duplex, machineHead: Buffer) {
  const close = () => {
    client.destroy()
    machine.destroy()
  }
  if (machineHead.length > 0) client.write(machineHead)
  if (clientHead.length > 0) machine.write(clientHead)
  client.on("error", close).on("close", close)
  machine.on("error", close).on("close", close)
  machine.pipe(client)
  client.pipe(machine)
}

function carriedIncoming(env: unknown): IncomingMessage | undefined {
  if (typeof env !== "object" || env === null || !("incoming" in env)) return undefined
  return env.incoming instanceof IncomingMessage ? env.incoming : undefined
}

export function createDirectRouteCarrier(options: {
  interfaces?: () => NetworkInterfaces
  /** Handed every machine this carrier reaches with the owner's token, to serve it this desktop's broker. */
  ownerBroker?: OwnerBrokerDialer
} = {}) {
  const interfaces = options.interfaces ?? (() => os.networkInterfaces())
  const registered = new Map<string, DirectRoutes>()
  const answering = new Map<string, { address: string; network: string }>()
  const probes = new Map<string, Promise<string | undefined>>()
  const agents = new Map<string, PinnedAgent>()
  const pendingUpgrades = new WeakMap<IncomingMessage, PendingUpgrade>()
  const machineKey = (routes: DirectRoutes) => `${routes.spkiSha256}:${routes.port}`
  const targetOf = (routes: DirectRoutes, address: string): DirectTarget => ({ address, port: routes.port, spkiSha256: routes.spkiSha256 })

  const probe = async (routes: DirectRoutes): Promise<string | undefined> => {
    const local = interfaces()
    const ordered = [...routes.addresses].sort((a, b) => addressRank(a, local) - addressRank(b, local))
    const attempts = ordered.map((address) => pinnedConnection(targetOf(routes, address), PROBE_TIMEOUT_MS).then((socket) => {
      socket.destroy()
      return true
    }, () => false))
    for (const [index, attempt] of attempts.entries()) if (await attempt) return ordered[index]
    return undefined
  }

  const reachable = async (workspaceId: string): Promise<DirectTarget | undefined> => {
    const routes = registered.get(workspaceId)
    if (!routes) return undefined
    const key = machineKey(routes)
    const network = interfaceSignature(interfaces())
    const known = answering.get(key)
    if (known && known.network === network && routes.addresses.includes(known.address)) return targetOf(routes, known.address)
    const pending = probes.get(key) ?? probe(routes).finally(() => probes.delete(key))
    probes.set(key, pending)
    const address = await pending
    if (!address) {
      answering.delete(key)
      return undefined
    }
    answering.set(key, { address, network })
    return targetOf(routes, address)
  }

  const forget = (target: DirectTarget) => {
    const key = `${target.spkiSha256}:${target.port}`
    if (answering.get(key)?.address === target.address) answering.delete(key)
    const agentKey = `${key}@${target.address}`
    agents.get(agentKey)?.destroy()
    agents.delete(agentKey)
  }

  const agentFor = (target: DirectTarget) => {
    const key = `${target.spkiSha256}:${target.port}@${target.address}`
    const agent = agents.get(key) ?? new PinnedAgent(target, CONNECT_TIMEOUT_MS)
    agents.set(key, agent)
    return agent
  }

  const forward = (c: Context, target: DirectTarget, path: string, token: string) => new Promise<Response>((resolve) => {
    const method = c.req.method
    const upstream = httpRequest({ agent: agentFor(target), host: target.address, port: target.port, method, path, headers: outboundHeaders(c.req.raw.headers, target, token) }, (answer) => resolve(webResponse(answer, method)))
    upstream.on("error", (error) => {
      forget(target)
      const resendable = error instanceof DirectRouteUnreachable || method === "GET" || method === "HEAD"
      resolve(resendable ? unavailable() : directRouteRefusal("direct_route_broken", 502, "The machine's direct route broke while the request was in flight"))
    })
    const body = c.req.raw.body
    if (body && method !== "GET" && method !== "HEAD") void sendBody(body, upstream).catch((error: unknown) => upstream.destroy(error instanceof Error ? error : undefined))
    else upstream.end()
  })

  const register = async (c: Context) => {
    const parsed = routesBody.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: { code: "direct_routes_invalid", message: "Direct routes must name a port, private-network addresses and a key pin" } }, 400)
    registered.set(c.req.param("workspaceId") ?? "", parsed.data)
    const target = await reachable(c.req.param("workspaceId") ?? "")
    return target ? c.json({ address: target.address }) : unavailable()
  }

  const route = async (c: Context) => {
    const match = DIRECT_PATH.exec(new URL(c.req.url).pathname)
    const workspaceId = decodeURIComponent(match?.[1] ?? "")
    const upgrading = c.req.header("upgrade")?.toLowerCase() === "websocket"
    const token = upgrading ? offeredRuntimeAccessToken(c.req.header("sec-websocket-protocol")) ?? bearerToken(c.req.header("authorization")) : bearerToken(c.req.header("authorization"))
    if (!token) return directRouteRefusal("direct_route_token_required", 401, "A direct request carries the workspace's runtime access token")
    const target = await reachable(workspaceId)
    if (!target) return unavailable()
    options.ownerBroker?.offer({ target, token })
    const path = `/workspaces/${encodeURIComponent(workspaceId)}${match?.[2] ?? "/"}${new URL(c.req.url).search}`
    if (!upgrading) return await forward(c, target, path, token)
    const incoming = carriedIncoming(c.env)
    if (!incoming) return directRouteRefusal(DIRECT_ROUTE_UNAVAILABLE, 503, "This upgrade did not arrive on a socket the daemon can carry")
    pendingUpgrades.set(incoming, { target, token, path })
    return c.body(null, 204)
  }

  const carryUpgrade = async (app: Pick<Hono, "request">, request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!request.headers.host) return refuseUpgrade(socket, 400)
    const headers = new Headers(Object.entries(request.headers).flatMap(([name, value]) => (value === undefined ? [] : [[name, Array.isArray(value) ? value[0] : value] as [string, string]])))
    const answer = await app.request(new URL(request.url ?? "/", `http://${request.headers.host}`), { headers }, { incoming: request, outgoing: undefined })
    const pending = pendingUpgrades.get(request)
    pendingUpgrades.delete(request)
    if (!pending) return refuseUpgrade(socket, answer.status)
    let machine: TLSSocket
    try {
      machine = await pinnedConnection(pending.target, CONNECT_TIMEOUT_MS)
    } catch {
      forget(pending.target)
      return refuseUpgrade(socket, 503)
    }
    const offered = offeredRuntimeAccessToken(request.headers["sec-websocket-protocol"])
    const others = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((item) => item.trim()).filter((item) => item && !item.startsWith(RUNTIME_ACCESS_TOKEN_PROTOCOL))
    const upstream = httpRequest({
      createConnection: () => machine,
      method: "GET",
      path: pending.path,
      headers: { ...outboundHeaders(request.headers, pending.target, pending.token), connection: "Upgrade", upgrade: "websocket", ...(others.length ? { "sec-websocket-protocol": others.join(", ") } : {}) },
    })
    upstream.once("upgrade", (switched, carried, carriedHead) => {
      socket.write(switchHead(switched, offered))
      splice(socket, head, carried, carriedHead)
    })
    upstream.once("response", (refused) => {
      refused.resume()
      machine.destroy()
      refuseUpgrade(socket, refused.statusCode ?? 502)
    })
    upstream.once("error", () => refuseUpgrade(socket, 502))
    upstream.end()
  }

  const forgetAll = (c: Context) => {
    registered.clear()
    answering.clear()
    for (const agent of agents.values()) agent.destroy()
    agents.clear()
    options.ownerBroker?.forget()
    return c.body(null, 204)
  }

  return {
    register,
    route,
    /** Forgets every route and token it was handed, as when the owner signs out; the renderer registers again when it carries one. */
    forgetAll,
    /** Takes the upgrades this route answers off the server; every other upgrade reaches `others` as it would have reached the server. */
    injectWebSocket: (server: EventEmitter, app: Pick<Hono, "request">, others: EventEmitter) => {
      server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (DIRECT_PATH.test(request.url ?? "")) void carryUpgrade(app, request, socket, head).catch(() => refuseUpgrade(socket, 502))
        else others.emit("upgrade", request, socket, head)
      })
    },
  }
}
