/**
 * Node-server Sentry wiring (D12, ops floor ADR
 * docs/plans/2026-07-11-016-wp-ops-floor-design.md §4). Node-only: imported
 * by server.ts, NEVER by worker.ts/hosted-app.ts — the Worker registers its
 * own @sentry/cloudflare sink directly in worker.ts, and the Worker
 * import-graph guard keeps this module (and @sentry/node) out of that graph.
 *
 * DSN-absent contract: without CLAXEDO_SENTRY_DSN this returns
 * { enabled: false } WITHOUT calling Sentry.init at all — zero SDK overhead,
 * zero network (Sentry's own recommendation for conditional enablement).
 */

import * as Sentry from "@sentry/node"
import { setErrorReporterSink } from "./report"
import { sentryInitOptions, type ObservabilityEnv } from "./sentry-config"

export function initNodeObservability(env: ObservabilityEnv = process.env): { enabled: boolean } {
  const options = sentryInitOptions(env, "server")
  if (!options.enabled || !options.dsn) return { enabled: false }
  Sentry.init({
    dsn: options.dsn,
    ...(options.release ? { release: options.release } : {}),
    tracesSampleRate: 0,
    initialScope: options.initialScope,
    // The server owns its own SIGTERM shutdown and error surfaces; Sentry's
    // default OnUncaughtException integration would exit the process for us.
    // Keep exits under server.ts's control.
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "OnUncaughtException"),
  })
  setErrorReporterSink((error, context) => {
    Sentry.withScope((scope) => {
      scope.setTags(context.tags)
      if (Object.keys(context.extra).length > 0) scope.setExtras(context.extra)
      Sentry.captureException(error)
    })
  })
  return { enabled: true }
}
