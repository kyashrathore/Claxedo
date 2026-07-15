import { Hono } from "hono"
import { createFixedWindowConnectionRateLimiter, type ConnectionRateLimiter } from "../control-plane/rate-limit"
import type { ControlPlaneTelemetry } from "../control-plane/services"
import { errorBody } from "./http"
import { internalAdminAuthorized } from "./internal-admin-auth"

export type WorkGraphReconcileResult = Readonly<{
  launched: readonly unknown[]
  results: readonly unknown[]
  background?: Readonly<{
    controls: readonly unknown[]
    intake: Readonly<{ completed: number }>
    launched: readonly unknown[]
    results: readonly unknown[]
    sourcePlanning: Readonly<{ launched: readonly unknown[]; results: readonly unknown[] }>
  }>
}>

export type HostedWorkGraphAdminOptions = Readonly<{
  adminToken?: string
  reconcile?: () => Promise<WorkGraphReconcileResult>
  rateLimiter?: ConnectionRateLimiter
  telemetry?: ControlPlaneTelemetry
}>

export function HostedWorkGraphAdminRoutes(options: HostedWorkGraphAdminOptions = {}) {
  const app = new Hono()
  const rateLimiter = options.rateLimiter ?? createFixedWindowConnectionRateLimiter({ limit: 6, windowMs: 60_000 })
  let active = false

  app.use("/internal/workgraph/reconcile", async (context, next) => {
    if (!internalAdminAuthorized(context.req.raw, options.adminToken)) {
      return context.json(
        errorBody("workgraph_admin_unauthorized", "WorkGraph reconciliation requires a matching admin bearer token"),
        401,
      )
    }
    await next()
  })

  app.post("/internal/workgraph/reconcile", async (context) => {
    if (!options.reconcile) {
      return context.json(
        errorBody("workgraph_reconcile_unavailable", "Hosted WorkGraph reconciliation is not configured"),
        501,
      )
    }
    if (new URL(context.req.url).search || (await context.req.text()).trim()) {
      return context.json(
        errorBody(
          "workgraph_reconcile_selector_forbidden",
          "WorkGraph reconciliation accepts no owner, workspace, Stream, or Task selector",
        ),
        400,
      )
    }
    const limit = rateLimiter.check({ userId: "system", workspaceId: "workgraph-reconcile" })
    if (!limit.allowed) {
      context.header("retry-after", String(Math.max(1, Math.ceil(limit.retryAfterMs / 1_000))))
      return context.json(
        errorBody("workgraph_reconcile_rate_limited", "WorkGraph reconciliation is rate limited"),
        429,
      )
    }
    if (active) {
      return context.json(
        errorBody("workgraph_reconcile_in_progress", "WorkGraph reconciliation is already running in this Worker"),
        409,
      )
    }
    active = true
    try {
      const result = await options.reconcile()
      const summary = {
        launched: result.launched.length,
        results: result.results.length,
        ...(result.background
          ? {
              controls: result.background.controls.length,
              intake: result.background.intake.completed,
              backgroundLaunched: result.background.launched.length,
              backgroundResults: result.background.results.length,
              sourcePlansLaunched: result.background.sourcePlanning.launched.length,
              sourcePlanResults: result.background.sourcePlanning.results.length,
            }
          : {}),
      }
      options.telemetry?.capture("system", "workgraph.reconcile", summary)
      return context.json({ ok: true, summary })
    } finally {
      active = false
    }
  })

  return app
}
