import type { MiddlewareHandler } from "hono"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthConfig,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../control-plane/auth"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  label: string
  missingBearerAsAuthError?: boolean
}

function localOnlyBody(label: string) {
  return {
    error: {
      code: "local_only_projection_route",
      message: `${label} is local-only and is not available through signed/team Control Plane access`,
    },
  }
}

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
  const peer = requestPeerAddress(request)
  if (peer !== undefined) {
    if (!isLoopbackAddress(peer)) return false
    // Loopback peer + forwarded marker = a local reverse proxy fronting
    // external traffic. Trust the proxy's client claim over the socket;
    // clients adding the header themselves can only restrict their access.
    const forwardedClient = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwardedClient && !isLoopbackAddress(forwardedClient)) return false
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

export async function localOnlyProjectionResponse(request: Request, options: Options) {
  if (isLoopbackLocalRequest(request)) return
  const config = options.authConfig ?? controlPlaneAuthConfig()
  const token = bearerToken(request.headers.get("authorization"))
  if (!token && options.missingBearerAsAuthError) {
    try {
      await controlPlaneAuthContext(request, {
        config,
        verifier: options.verifier,
      })
      return
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) {
        return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
      }
      throw err
    }
  }
  if (!token) return Response.json(localOnlyBody(options.label), { status: 403 })
  if (!config.enabled && config.mode === "local-only" && token) {
    return Response.json(localOnlyBody(options.label), { status: 403 })
  }
  try {
    await controlPlaneAuthContext(request, {
      config,
      verifier: options.verifier,
    })
    return Response.json(localOnlyBody(options.label), { status: 403 })
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
    }
    throw err
  }
}

export function localOnlyProjection(options: Options): MiddlewareHandler {
  return async (c, next) => {
    const response = await localOnlyProjectionResponse(c.req.raw, options)
    if (response) return response
    await next()
  }
}
