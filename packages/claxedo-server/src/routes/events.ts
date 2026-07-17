import { streamSSE } from "hono/streaming"
import { claxedoBus, type ClaxedoEvent } from "../bus"
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

// Rubric S1 + per-event authorization: authenticating a subscriber is not
// enough — the bus is server-global, so without a per-event filter any valid
// bearer (any user, any org) would observe every other tenant's events.
// Allowlist with default-deny: an event type is only delivered to a signed
// subscriber if it has an explicit scope rule matching the caller's identity.
// New event types added to the ClaxedoEvent union are therefore invisible to
// signed subscribers until they carry a scope and gain a rule here — they can
// leak by omission of delivery, never by omission of authorization.
export function eventVisibleTo(ctx: ControlPlaneAuthContext, event: ClaxedoEvent): boolean {
  // Single-user modes: the whole bus belongs to this caller.
  if (ctx.mode === "unsigned-local") return true

  switch (event.type) {
    case "workgraph.changed":
      // ownerUserId is stamped from auth.user.subject at publish
      // (server-workgraph.ts); "local" marks unsigned-local publishes.
      return event.ownerUserId === ctx.user.subject
    case "document.changed":
      return !!ctx.user.orgId && event.orgId === ctx.user.orgId
    case "provision":
      // orgId is stamped from Workspace.org_id at publish (provision-events.ts);
      // org-less (local) workspaces stay invisible to signed subscribers.
      return !!ctx.user.orgId && event.orgId === ctx.user.orgId
    default:
      // pty.*, agent.lifecycle, process.*, session.lifecycle, worktree.* carry
      // no owner identity: they are local-execution events whose hosted
      // equivalents flow on per-workspace runtime streams (routed off by
      // workspaceRuntimeProxy before this handler), so a signed subscriber to
      // the central stream is never their legitimate consumer.
      return false
  }
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
