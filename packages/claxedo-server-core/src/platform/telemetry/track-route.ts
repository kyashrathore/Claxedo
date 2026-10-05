import { Hono } from "hono"
import { decodeProductEvent } from "@claxedo/account-contract/product-events"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "../auth/auth"
import { errorBody } from "../http/http"
import type { ControlPlaneTelemetry } from "./ports"

const TRACK_RATE_LIMIT = 120
const TRACK_RATE_WINDOW_MS = 60_000

export type TrackIdentity = { userId: string; orgId: string }

/**
 * `POST /api/claxedo/track`. The event is attributed to the signed caller the
 * route resolves itself, never to an id in the body. Each caller gets its own
 * window per isolate; the windows are dropped together when the period turns,
 * so the map never outlives one period.
 */
export function TelemetryTrackRoutes(input: {
  identity: (request: Request) => Promise<TrackIdentity | undefined>
  telemetry: ControlPlaneTelemetry
  now?: () => number
}) {
  const now = input.now ?? Date.now
  let counts = new Map<string, number>()
  let resetAt = 0
  const admit = (userId: string) => {
    const at = now()
    if (at >= resetAt) {
      resetAt = at + TRACK_RATE_WINDOW_MS
      counts = new Map()
    }
    const count = (counts.get(userId) ?? 0) + 1
    counts.set(userId, count)
    return count <= TRACK_RATE_LIMIT ? undefined : resetAt - at
  }
  return new Hono().post("/api/claxedo/track", async (c) => {
    let identity: TrackIdentity | undefined
    try {
      identity = await input.identity(c.req.raw)
    } catch (error) {
      if (!(error instanceof ControlPlaneAuthError)) throw error
      return c.json(controlPlaneAuthErrorBody(error), error.status)
    }
    if (!identity) return c.json(errorBody("signed_org_required", "A signed organization session is required"), 401)
    const retryAfterMs = admit(identity.userId)
    if (retryAfterMs !== undefined) {
      return c.json(
        { error: { code: "rate_limited", message: "Request limit exceeded", retryAfterMs } },
        429,
        { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
      )
    }
    const decoded = decodeProductEvent(await c.req.json().catch(() => null))
    if (!decoded.ok) return c.json(errorBody("telemetry_event_refused", "Event is not one this product emits", { reason: decoded.reason }), 400)
    input.telemetry.capture(identity.userId, decoded.value.event, {
      ...decoded.value.properties,
      org_id: identity.orgId,
      $groups: { org: identity.orgId },
    })
    return c.json({ ok: true })
  })
}
