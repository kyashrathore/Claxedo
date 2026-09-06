/**
 * The workerd globals this package constructs, declared once.
 *
 * This package models the Cloudflare Workers surface structurally and
 * deliberately carries no `@cloudflare/workers-types` dependency (see the
 * `WorkspaceRelayDurableObject*` types in `./cloudflare` and the header of
 * `./workerd-fixture/binary-frame-worker`): pulling workers-types in would
 * replace `Request`, `Response` and `WebSocket` package-wide. That left the
 * runtime-provided `WebSocketPair` constructor undeclared, so each call site
 * asserted its way onto `globalThis`. Declaring it here is the same structural
 * modelling the rest of the package does, in one place.
 *
 * The element type is the caller's own model of a workerd socket — the relay's
 * `WorkspaceRelayDurableObjectSocket`, or the fixture's `FixtureSocket` — which
 * is why the constructor is generic rather than pinned to one of them.
 */
declare global {
  const WebSocketPair: new <Socket>() => { 0: Socket; 1: Socket }
}

export {}
