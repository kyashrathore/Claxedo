/**
 * Node-server error sink. Node-only: imported by server.ts and main.ts, NEVER
 * by worker.ts/hosted-app.ts — `posthog-node` is on the Worker's forbidden-
 * import list and the Worker import-graph guard keeps this module out of that
 * graph. The Worker registers its own fetch-based sink in worker.ts.
 *
 * One client, two planes: the sink reuses the `posthog-node` client that
 * posthog.ts already owns, so product events and exceptions share a connection,
 * a flush schedule, and one shutdown path.
 *
 * Key-absent contract: without a PostHog key this returns { enabled: false }
 * WITHOUT constructing a client and WITHOUT registering a sink — zero SDK
 * overhead, zero network, and report.ts's own no-sink branch keeps every
 * reportError call a silent no-op.
 */

import { initPostHog } from "../observability/posthog"
import { setErrorReporterSink } from "./report"
import { observabilityOptions, type ObservabilityEnv } from "./config"

export function initNodeObservability(env: ObservabilityEnv = process.env): { enabled: boolean } {
  const options = observabilityOptions(env, "server")
  if (!options.enabled) return { enabled: false }
  const client = initPostHog(env)
  if (!client) return { enabled: false }
  setErrorReporterSink((error, context) => {
    // Product-plane identity when a call site knows it; the ops-plane "system"
    // principal otherwise. A boot or background failure genuinely has no user.
    const distinctId = context.tags.user_id || "system"
    // I-5 (never report credential material): the payload is EXACTLY the base
    // tags plus the caller's tags/extra. posthog-node attaches no request
    // context of its own — no headers, cookies, query strings, or bodies — so
    // the credential-scrub class of bug cannot occur on this path. Keep it
    // that way: never pass request objects or header maps into tags/extra.
    client.captureException(error, distinctId, {
      ...options.tags,
      ...context.tags,
      ...context.extra,
    })
  })
  return { enabled: true }
}
