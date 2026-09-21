import { Hono } from "hono"
import { z } from "zod"
import { controlPlaneAuthContext, ControlPlaneAuthError, localControlPlaneAuth, type ControlPlaneAuthAdapter } from "../auth/auth"
import { errorBody } from "../http/http"
import type { ControlPlaneTelemetry } from "./ports"

const TRACK_PROPERTIES_MAX_KEYS = 32
const TRACK_PROPERTIES_MAX_BYTES = 4096
const TRACK_RATE_LIMIT = 120
const TRACK_RATE_WINDOW_MS = 60_000

/**
 * The event names the route accepts: the ones the app's own telemetry emits —
 * its `phCapture` literals, the onboarding funnel, the turn-outcome pair, the
 * shell flow-log events and PostHog's exception event. Anything else did not
 * come from this product.
 */
export const TRACK_EVENTS: ReadonlySet<string> = new Set([
  "app_launched",
  "app_state_snapshot",
  "context_selection_added",
  "harness_selected",
  "model_selected",
  "permission_decided",
  "prompt_aborted",
  "prompt_sent",
  "session_new",
  "setting_changed",
  "update_checked",
  "update_installed",
  "$exception",
  "signup",
  "setup_form_shown",
  "setup_form_dismissed",
  "step_done",
  "step_verify_failed",
  "provider_connected",
  "first_turn_ok",
  "first_turn_failed",
  "sandbox_provider_configured",
  "first_cloud_turn_ok",
  "remote_access_enabled",
  "second_device_open",
  "gofurther_card_clicked",
  "gofurther_card_dismissed",
  "turn_completed",
  "turn_failed",
  "navigate",
  "new_project_selected",
  "new_review_click",
  "new_session_click",
  "new_session_cloud_guard",
  "new_terminal_click",
  "session_select",
  "tab_select",
  "workspace_created",
  "workspace_select",
])

const TrackBody = z.object({
  event: z.string(),
  properties: z
    .record(z.string(), z.unknown())
    .refine(
      (properties) =>
        Object.keys(properties).length <= TRACK_PROPERTIES_MAX_KEYS &&
        JSON.stringify(properties).length <= TRACK_PROPERTIES_MAX_BYTES,
    )
    .optional(),
})

/**
 * `POST /api/claxedo/track`, the one owner for every deployment. The event is
 * attributed to an identity the route derives itself — the verified subject
 * when a bearer verifies, the unsigned-local owner otherwise — so a
 * `distinctId` in the body is never honored, and a bearer that fails to verify
 * is refused rather than folded into the local bucket.
 */
export function TelemetryTrackRoutes(input: { auth: ControlPlaneAuthAdapter; telemetry: ControlPlaneTelemetry }) {
  // One window for the whole route: the only legitimate caller is the
  // product's own application, so keying by caller buys nothing — the bound
  // is the telemetry sink's.
  let count = 0
  let resetAt = 0
  return new Hono().post("/api/claxedo/track", async (c) => {
    const now = Date.now()
    if (now >= resetAt) {
      resetAt = now + TRACK_RATE_WINDOW_MS
      count = 0
    }
    count += 1
    if (count > TRACK_RATE_LIMIT) {
      const retryAfterMs = resetAt - now
      return c.json(
        { error: { code: "rate_limited", message: "Request limit exceeded", retryAfterMs } },
        429,
        { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
      )
    }
    let distinctId: string
    try {
      const identity = await controlPlaneAuthContext(c.req.raw, {
        config: input.auth.config,
        ...(input.auth.verifier ? { verifier: input.auth.verifier } : {}),
      })
      distinctId = identity.mode === "signed" ? identity.user.subject : localControlPlaneAuth().user.subject
    } catch (error) {
      if (!(error instanceof ControlPlaneAuthError)) throw error
      return c.json(errorBody(error.code, error.message), error.status)
    }
    const parsed = TrackBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(errorBody("telemetry_invalid_body", "Invalid telemetry request body"), 400)
    if (!TRACK_EVENTS.has(parsed.data.event)) {
      return c.json(errorBody("telemetry_unknown_event", "Event is not one this product emits"), 400)
    }
    input.telemetry.capture(distinctId, parsed.data.event, parsed.data.properties)
    return c.json({ ok: true })
  })
}
