/**
 * The relay's upstream WebSocket constructor, and the one place that names it.
 *
 * A relay client socket is proxied to a workspace runtime over a second,
 * outbound WebSocket that must carry the runtime's auth headers. Bun's global
 * `WebSocket` really does accept `(url, { headers })` — but that shape is not
 * expressible in this package's type program, for a reason that is worth
 * writing down once rather than rediscovering at the call site:
 *
 * `bun-types` yields its own `WebSocket` declaration to `lib.dom` whenever
 * `lib.dom` is loaded (`Bun.__internal.UseLibDomIfAvailable`), and `lib.dom`
 * declares only the `(url, protocols)` overload — on a `declare var`, which
 * cannot be augmented. So while `lib.dom` is in `tsconfig.json`, the real
 * constructor is unreachable through the global's type.
 *
 * Dropping `lib.dom` (as `bench/tsconfig.json` does) fixes THIS and breaks more
 * than it fixes: `bun-types`' `Request` constructor declares `string`,
 * `RequestInit & { url }` and `Request` inputs and no `URL` input at all, which
 * this package and its tests rely on.
 *
 * The assertion is therefore genuine — the type system cannot express the
 * value — and it is confined to this module so that the lint override excusing
 * it covers ~40 lines whose only job is this constructor, rather than blinding
 * the 4,000-line `bun.ts` that consumes it.
 */
export type UpstreamWebSocketConstructor = {
  new(url: string, options: Bun.WebSocketOptions): WebSocket
}

/**
 * The constructor used to open the upstream socket: the caller's override when
 * one is supplied (tests inject fakes to drive open timeouts, pre-open queue
 * limits and abnormal closes), otherwise Bun's global `WebSocket`.
 */
export function resolveUpstreamWebSocket(override?: UpstreamWebSocketConstructor): UpstreamWebSocketConstructor {
  return override ?? (WebSocket as unknown as UpstreamWebSocketConstructor)
}
