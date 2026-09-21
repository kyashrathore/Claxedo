import type { MiddlewareHandler } from "hono"
import {
  isLoopbackIpAddress,
  parseIpAddress,
  requestPeerAddress,
  stampRequestPeerAddress,
} from "@claxedo/helpers"

export { requestPeerAddress, stampRequestPeerAddress }

/**
 * The unsigned-local request gate.
 *
 * Peer extraction — reading where the socket says a request came from —
 * lives in @claxedo/helpers so a package that cannot depend on this one
 * (@claxedo/mcp, whose loopback gate applies the same peer check) shares
 * the one stamp and the one read of the adapter internals. What stays here
 * is the policy only this composition has: the hono middleware that stamps
 * ahead of every gate, which requests count as local, and the header list
 * that disqualifies a request from that trust.
 */
function loopbackHost(input: string) {
  return input === "localhost" || input === "127.0.0.1" || input === "::1" || input === "[::1]"
}

/**
 * Headers that describe an ORIGINAL client behind a proxy. Their presence is
 * what disqualifies a request from unsigned-local trust below, so the replay
 * set beneath is built from this one rather than kept as a second list that
 * can drift from the gate.
 */
export const FORWARDED_CLIENT_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const

/**
 * What a machine must NOT carry onto its own loopback replay of a
 * relay-delivered request.
 *
 * A request that arrives over a host tunnel is replayed as a fetch the machine
 * makes to its own `127.0.0.1` server, and that server's relay-shaped surface
 * requires exactly that (`isLoopbackLocalRequest` below). Replaying the remote
 * caller's headers verbatim makes a genuinely-local request look proxied and
 * the gate refuses it: an edge stamps `cf-connecting-ip`/`x-forwarded-*` on
 * everything reaching the relay, the browser sends a foreign `Origin`, and
 * `host` names the relay — each one alone fails the gate.
 *
 * Stripping is scoped to the tunnel's own replay, so ordinary browser traffic
 * to loopback keeps its Origin and its CSRF protection. The headers describe a
 * client that is not the one making the local request; authorization for relay
 * traffic is the relay's verified Runtime Access Token plus each serving
 * module's own registration and route-ownership guards, not the socket the
 * request arrived on.
 *
 * It lives beside the gate it has to satisfy: every replaying host has the
 * same obligation and hands this to `startWorkspaceRelayHostTunnel`'s
 * `localReplayHeaders`, so a host that kept its own copy would drift from the
 * gate silently — its requests would simply stop being trusted.
 */
const REPLAY_STRIPPED_HEADERS = [...FORWARDED_CLIENT_HEADERS, "origin", "host"] as const

export function loopbackReplayHeaders(input: Record<string, string>): Record<string, string> {
  const stripped = new Set<string>(REPLAY_STRIPPED_HEADERS)
  return Object.fromEntries(Object.entries(input).filter(([name]) => !stripped.has(name.toLowerCase())))
}

// Stamps the peer from `c.env.incoming` (set by both @hono/node-server and
// @hono/node-ws), so gates behind it see the peer even on Requests node-ws
// rebuilt without the adapter internals. Absent env (Workers, in-process
// test fetch) this is a no-op.
export function peerAddressStamp(): MiddlewareHandler {
  return async (c, next) => {
    stampRequestPeerAddress(c.req.raw, c.env)
    await next()
  }
}

export function isLoopbackLocalRequest(request: Request) {
  // Forwarding destroys the direct socket-to-client relationship required by
  // unsigned-local mode. Header chains are client-spoofable unless a specific
  // trusted proxy policy parses them, so this generic gate always fails closed.
  if (FORWARDED_CLIENT_HEADERS.some((header) => request.headers.has(header))) return false
  // The URL hostname comes from the client-controlled Host header, so it can
  // never be the only loopback gate: the server may bind 0.0.0.0
  // (CLAXEDO_SERVER_HOST), and a remote client sending `Host: 127.0.0.1` must
  // not be classified local. The transport peer is checked whenever the
  // adapter exposed one.
  const peer = requestPeerAddress(request)
  if (peer !== undefined) {
    const ip = parseIpAddress(peer)
    if (!ip || !isLoopbackIpAddress(ip)) return false
  }
  // When no connection info exists (in-process fetch: tests, embedded
  // callers, Workers) the Host/Origin checks below remain the gate,
  // matching the pre-socket behavior for trusted in-process traffic.
  const url = new URL(request.url)
  if (!loopbackHost(url.hostname)) return false
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return loopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}
