/**
 * Worker-safe telemetry. The local server uses `posthog-node` (a Node library);
 * the hosted Worker posts capture events to the PostHog HTTP API over `fetch`
 * (or no-ops when unconfigured). Never imports `posthog-node`.
 *
 * Telemetry is fire-and-forget operational evidence and must never throw into a
 * request handler or block the response.
 */

import type { ControlPlaneTelemetry } from "./services"

type TelemetryEnv = {
  CLAXEDO_POSTHOG_KEY?: string
  CLAXEDO_POSTHOG_HOST?: string
}

export function workerTelemetry(env: TelemetryEnv = {}): ControlPlaneTelemetry {
  const key = env.CLAXEDO_POSTHOG_KEY?.trim()
  const host = (env.CLAXEDO_POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "")
  if (!key) {
    return { capture: () => {} }
  }
  return {
    capture: (distinctId, event, properties) => {
      try {
        void fetch(`${host}/capture/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            event,
            distinct_id: distinctId,
            properties: properties ?? {},
          }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {})
      } catch {
        // Telemetry must never break the request.
      }
    },
  }
}
