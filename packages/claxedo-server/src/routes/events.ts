import { streamSSE } from "hono/streaming"
import { claxedoBus } from "../bus"
import type { Context } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../control-plane/auth"
import { isLoopbackLocalRequest } from "./local-only-projection"

export type EventsHandlerOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  allowLoopbackLocal?: boolean
}

export function eventsHandler(options: EventsHandlerOptions = {}) {
  return async function handler(c: Context) {
    // Rubric S1: every claxedoBus subscriber must pass the same control-plane
    // auth gate as the other claxedo routes. Without this gate an anonymous
    // connection (even from another origin if CORS allows) would tap the
    // global event bus and observe every user's session/workspace activity
    // events. In local/unsigned-local mode the gate is a pass-through.
    try {
      if (options.allowLoopbackLocal && isLoopbackLocalRequest(c.req.raw)) return streamClaxedoEvents(c)
      await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      }
      throw err
    }
    return streamClaxedoEvents(c)
  }
}

function streamClaxedoEvents(c: Context) {
  return streamSSE(c, async (stream) => {
    const unsub = claxedoBus.subscribe((event) => {
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
