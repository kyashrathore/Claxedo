import { streamSSE } from "hono/streaming"
import { claxedoBus } from "../bus"
import type { Context } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
} from "../control-plane/auth"
import { isLoopbackLocalRequest } from "./local-only-projection"

// The per-event visibility predicate lives in the Worker-safe `event-visibility`
// module so the hosted `LiveSyncRoom` Durable Object can share the exact same
// scoping. Re-exported here for back-compat (events.test.ts imports it).
export { eventVisibleTo } from "./event-visibility"
import { eventVisibleTo } from "./event-visibility"

export type EventsHandlerOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  allowLoopbackLocal?: boolean
}

// Loopback requests bypass bearer auth (single-user desktop mode); model them
// as unsigned-local so the visibility predicate passes everything through.
const LOOPBACK_AUTH: ControlPlaneAuthContext = {
  mode: "unsigned-local",
  reason: "loopback local request",
}

export function eventsHandler(options: EventsHandlerOptions = {}) {
  return async function handler(c: Context) {
    // Rubric S1: every claxedoBus subscriber must pass the same control-plane
    // auth gate as the other claxedo routes. Without this gate an anonymous
    // connection (even from another origin if CORS allows) would tap the
    // global event bus and observe every user's session/workspace activity
    // events. In local/unsigned-local mode the gate is a pass-through.
    // D9 NOTE: the global `unsignedLocalRequestGuard` at the app-composition
    // root is now the PRIMARY unsigned-local gate (non-loopback unsigned is
    // rejected before this handler runs); the loopback check below stays as
    // defense-in-depth for compositions that mount this handler directly.
    try {
      if (options.allowLoopbackLocal && isLoopbackLocalRequest(c.req.raw)) {
        return streamClaxedoEvents(c, LOOPBACK_AUTH)
      }
      const ctx = await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      return streamClaxedoEvents(c, ctx)
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      }
      throw err
    }
  }
}

function streamClaxedoEvents(c: Context, ctx: ControlPlaneAuthContext) {
  return streamSSE(c, async (stream) => {
    const unsub = claxedoBus.subscribe((event) => {
      if (!eventVisibleTo(ctx, event)) return
      void stream.writeSSE({ data: JSON.stringify(event) })
    })

    const hb = setInterval(() => {
      void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) })
    }, 30000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(hb)
        unsub()
        resolve()
      })
    })
  })
}
