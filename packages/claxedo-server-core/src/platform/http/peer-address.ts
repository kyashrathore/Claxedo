import type { MiddlewareHandler } from "hono"

/**
 * Request peer-address primitives.
 *
 * Split out of `local-only-projection.ts`, which was two things: these, which
 * answer "where did this request come from", and the gate that uses them to
 * block signed/team access to a local-only feature. Six call sites across
 * different domains consume the gate, so both halves stay in platform/http —
 * but they are no longer one file.
 *
 * Worker-safe by construction: the Node socket is duck-typed rather than
 * imported, so this module pulls in no `node:*` dependency.
 */
function loopbackHost(input: string) {
  return input === "localhost" || input === "127.0.0.1" || input === "::1" || input === "[::1]"
}

// The URL hostname comes from the client-controlled Host header, so it can
// never be the only loopback gate: the server may bind 0.0.0.0
// (CLAXEDO_SERVER_HOST), and a remote client sending `Host: 127.0.0.1` must
// not be classified local. We therefore also require the transport peer
// address to be loopback whenever connection info is resolvable. This module
// is on the Worker-safe list, so the Node socket is duck-typed — no node:*
// imports.
type IncomingMessageLike = { socket?: { remoteAddress?: string } }

const requestPeerAddresses = new WeakMap<Request, string>()
/**
 * Headers that describe an ORIGINAL client behind a proxy. Their presence is
 * what disqualifies a request from unsigned-local trust below — exported so
 * the one component that legitimately replays a remote request onto loopback
 * (the machine's relay host tunnel, see
 * `claxedo-local-server/src/workspace/user-hosted-serving.ts`) strips exactly
 * this set instead of keeping a second copy that can drift from the gate.
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
 * It lives beside the gate it has to satisfy because every host that replays
 * has the same obligation: `claxedo-local-server`'s `user-hosted-serving` (the
 * daemon serving `claxedo up`) and `claxedo-server`'s `user-hosted-tunnel`
 * (the server serving its own local workspaces) both hand it to
 * `startWorkspaceRelayHostTunnel`'s `localReplayHeaders`.
 */
const REPLAY_STRIPPED_HEADERS = [...FORWARDED_CLIENT_HEADERS, "origin", "host"] as const

export function loopbackReplayHeaders(input: Record<string, string>): Record<string, string> {
  const stripped = new Set<string>(REPLAY_STRIPPED_HEADERS)
  return Object.fromEntries(Object.entries(input).filter(([name]) => !stripped.has(name.toLowerCase())))
}

// @hono/node-ws rebuilds upgrade Requests without the node-server internals,
// so the app stamps the peer address explicitly from `c.env.incoming` (set by
// both @hono/node-server and @hono/node-ws). Absent env (Workers, in-process
// test fetch) this is a no-op.
export function stampRequestPeerAddress(request: Request, env: unknown) {
  const incoming = (env as { incoming?: IncomingMessageLike } | null | undefined)?.incoming
  const address = incoming?.socket?.remoteAddress
  if (typeof address === "string" && address) requestPeerAddresses.set(request, address)
}

export function peerAddressStamp(): MiddlewareHandler {
  return async (c, next) => {
    stampRequestPeerAddress(c.req.raw, c.env)
    await next()
  }
}

// @hono/node-server keeps the Node IncomingMessage on the Request under
// Symbol("incomingKey") — a fallback for requests that reach a gate without
// passing the stamp middleware. local-only-projection.test.ts pins this
// against the real library so a node-server upgrade that renames the symbol
// fails loudly.
function nodeServerPeerAddress(request: Request): string | undefined {
  for (const sym of Object.getOwnPropertySymbols(request)) {
    if (sym.description !== "incomingKey") continue
    const incoming = (request as unknown as Record<symbol, IncomingMessageLike | undefined>)[sym]
    const address = incoming?.socket?.remoteAddress
    if (typeof address === "string" && address) return address
  }
  return undefined
}

function isLoopbackAddress(address: string) {
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
  if (bare === "::1") return true
  return /^127(\.\d{1,3}){3}$/.test(bare)
}

export function requestPeerAddress(request: Request): string | undefined {
  return requestPeerAddresses.get(request) ?? nodeServerPeerAddress(request)
}

export function isLoopbackLocalRequest(request: Request) {
  // Forwarding destroys the direct socket-to-client relationship required by
  // unsigned-local mode. Header chains are client-spoofable unless a specific
  // trusted proxy policy parses them, so this generic gate always fails closed.
  if (FORWARDED_CLIENT_HEADERS.some((header) => request.headers.has(header))) return false
  const peer = requestPeerAddress(request)
  if (peer !== undefined) {
    if (!isLoopbackAddress(peer)) return false
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
