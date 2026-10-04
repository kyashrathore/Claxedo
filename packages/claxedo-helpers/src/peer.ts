import { isRecord } from "./guards"

/**
 * The socket peer a server observed for an HTTP request — never a header,
 * which the client controls. Two provenance channels are read:
 *
 *   - an explicit stamp: `stampRequestPeerAddress` records the peer the
 *     serving adapter reports (`env.incoming` under @hono/node-server and
 *     @hono/node-ws). A Request rebuilt downstream of the adapter — node-ws
 *     constructs a fresh one for upgrades — carries no internals of its own,
 *     so the stamp is the only peer it can have;
 *   - the @hono/node-server `Symbol("incomingKey")` slot on the Request,
 *     which holds the Node `IncomingMessage` the socket belongs to.
 *
 * Both are duck-typed rather than imported, so this module pulls in no
 * `node:*` dependency. A Request carrying neither (workerd, in-process
 * fetch, tests) reports `undefined` and the caller's remaining gates decide
 * alone.
 */

/** The remote address a node IncomingMessage carries, if it has one. */
function incomingRemoteAddress(incoming: unknown): string | undefined {
  const socket = isRecord(incoming) ? incoming.socket : undefined
  const address = isRecord(socket) ? socket.remoteAddress : undefined
  return typeof address === "string" && address ? address : undefined
}

const requestPeerAddresses = new WeakMap<Request, string>()

/** Records the adapter-reported peer for `request`; a no-op when `env` carries no `incoming` socket. */
export function stampRequestPeerAddress(request: Request, env: unknown) {
  const address = incomingRemoteAddress(isRecord(env) ? env.incoming : undefined)
  if (address) requestPeerAddresses.set(request, address)
}

/**
 * @hono/node-server keeps the Node IncomingMessage on the Request under
 * Symbol("incomingKey") — the fallback for requests that reach a gate without
 * a stamp. local-only-projection.test.ts in claxedo-server-core pins this
 * against the real library so an upgrade renaming the symbol fails loudly.
 */
function nodeServerPeerAddress(request: Request): string | undefined {
  for (const sym of Object.getOwnPropertySymbols(request)) {
    if (sym.description !== "incomingKey") continue
    const address = incomingRemoteAddress(Reflect.get(request, sym))
    if (address) return address
  }
  return undefined
}

export function requestPeerAddress(request: Request): string | undefined {
  return requestPeerAddresses.get(request) ?? nodeServerPeerAddress(request)
}
