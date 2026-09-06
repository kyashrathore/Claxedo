import NodeWebSocket from "ws"

/**
 * The host tunnel's outbound socket, and the one place that names its type.
 *
 * Two things about this socket are not the DOM `WebSocket` the tunnel used to
 * be written against, and pretending otherwise cost a conversion here plus two
 * more at the ping site:
 *
 *   1. It is dialled with per-connection auth headers. The DOM constructor has
 *      no parameter for them; Node's `ws` does, and a test double supplies them
 *      directly.
 *   2. `ping` and `on("pong")` are RFC control-frame methods that real `ws`
 *      sockets have and injected browser-style doubles do not — so they are
 *      optional here, and the heartbeat fallback that covers a double is live
 *      code rather than a branch the type says is unreachable.
 *
 * Everything else is `ws`' own member types rather than a restatement of them,
 * which is what makes the constructor assignable with no conversion: `ws` types
 * its handlers with its own event classes, and DOM event types are assignable
 * to those (they carry `type` and `target` and more), so a DOM-typed double
 * satisfies them too. The reverse is what fails, and claiming DOM was the
 * reason the old conversion looked unavoidable.
 *
 * Unrelated to `workspace-relay`'s `upstream-websocket.ts`, which converts
 * Bun's GLOBAL `WebSocket` because `bun-types` yields to `lib.dom`. That is
 * about a global's declaration; this is about a package's class.
 */
export type TunnelWebSocket = Pick<
  NodeWebSocket,
  "binaryType" | "readyState" | "send" | "close" | "onopen" | "onmessage" | "onclose" | "onerror"
> & {
  ping?: () => void
  on?: (event: "pong", listener: () => void) => void
}

export type TunnelWebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => TunnelWebSocket

/**
 * The constructor used to open a tunnel socket: the caller's override when one
 * is supplied (tests inject fakes to drive reconnects, ping timeouts and
 * abnormal closes), otherwise Node's `ws`.
 */
export function resolveTunnelWebSocket(override?: TunnelWebSocketCtor): TunnelWebSocketCtor {
  return override ?? NodeWebSocket
}
