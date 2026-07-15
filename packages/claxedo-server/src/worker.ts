/**
 * Cloudflare Worker entrypoint for the hosted Claxedo control plane.
 *
 * This is the ONLY module Wrangler bundles as the Worker. It composes hosted
 * services from the Worker's `env` bindings and serves the Worker-safe
 * `hosted-app`. It imports nothing local: no `@hono/node-server`, no workspace
 * store/supervisor/embedded runtime/tunnel, no SQLite. See
 * `docs/tech-docs/claxedo-server-worker-deployment-plan.md`.
 *
 * The local Node server lives in `server.ts` and is unaffected by this file.
 *
 * D12 observability (ops floor ADR 2026-07-11-016 §4): the handler is wrapped
 * with `@sentry/cloudflare`'s `withSentry`
 * (https://docs.sentry.io/platforms/javascript/guides/cloudflare/ — requires
 * the `nodejs_compat` flag for AsyncLocalStorage, which wrangler.toml already
 * sets). Options come from env bindings via sentryInitOptions: absent
 * CLAXEDO_SENTRY_DSN → `enabled: false`, the SDK sends nothing (clean no-op
 * until the Sentry account exists). Release = git SHA (CLAXEDO_RELEASE,
 * passed by the D11 deploy workflow); events are tagged unit=worker +
 * deployment_mode.
 */

import type { ExecutionContext, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import * as Sentry from "@sentry/cloudflare"
import { composeHostedControlPlane, HostedWorkerCompositionError, type HostedControlPlane, type HostedWorkerEnv } from "./control-plane/hosted-services"
import { createHostedApp } from "./hosted-app"
import { runScheduledBillingReconciliation } from "./billing/reconcile"
import { reportError, setErrorReporterSink } from "./observability/report"
import { sentryInitOptions } from "./observability/sentry-config"
import { createHostedWorkGraphRuntime } from "./workgraph-host/hosted-runtime"

// D12: route reportError/reportPaymentError (the payment page-class hook the
// billing routes call) into the request's Sentry scope. withSentry runs the
// handler inside AsyncLocalStorage context, so captureException here lands on
// the current request's event. With no DSN the client is disabled and
// captureException is a documented no-op — no network.
setErrorReporterSink((error, context) => {
  Sentry.withScope((scope) => {
    scope.setTags(context.tags)
    if (Object.keys(context.extra).length > 0) scope.setExtras(context.extra)
    Sentry.captureException(error)
  })
})

let cached: {
  app: Hono
  plane: HostedControlPlane
  workGraphRuntime?: NonNullable<ReturnType<typeof createHostedWorkGraphRuntime>>
} | undefined

// D9 fail-closed hosted boot: `composeHostedControlPlane` asserts every
// hosted dependency/secret per-piece, and `createHostedApp` asserts the
// explicit deployment mode (CLAXEDO_DEPLOYMENT_MODE=hosted is REQUIRED) plus
// signed-auth/authority presence. Both throw HostedWorkerCompositionError,
// which `fetch` below maps to a 503 for EVERY request — the Worker is down,
// not open, when hosted config is missing.
function buildApp(env: HostedWorkerEnv): Hono {
  if (cached) return cached.app
  const plane = composeHostedControlPlane(env)
  const workGraphRuntime = createHostedWorkGraphRuntime(env, plane.services)
  const app = createHostedApp(plane, {
    ...(workGraphRuntime ? { workGraphReconcile: workGraphRuntime.reconcile } : {}),
  })
  // D12: Hono converts route exceptions into 500s internally, so they never
  // escape to withSentry — report them here, keeping Hono's default response
  // behavior (HTTPException responses pass through unreported; they are
  // deliberate 4xx/5xx, not error-tracker material). Guarded because tests
  // stub createHostedApp with a bare { fetch } object.
  if (typeof app.onError === "function") {
    app.onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse()
      reportError(err, {
        tags: { source: "hosted_app_route" },
        extra: { path: new URL(c.req.url).pathname, method: c.req.method },
      })
      console.error(err)
      return c.text("Internal Server Error", 500)
    })
  }
  cached = { app, plane, ...(workGraphRuntime ? { workGraphRuntime } : {}) }
  return app
}

function compositionErrorResponse(err: HostedWorkerCompositionError): Response {
  // Fail closed and loud when a required hosted dependency/secret is missing.
  return Response.json(
    { error: { code: err.code, message: err.message } },
    { status: 503 },
  )
}

// Minimal structural type for the Cloudflare Cron Trigger controller so the
// Worker keeps zero new runtime dependencies (same pattern as ExecutionContext
// above, which enters as a type only).
type ScheduledController = { cron: string; scheduledTime: number }

const handler = {
  async fetch(request: Request, env: HostedWorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    let app: Hono
    try {
      app = buildApp(env)
    } catch (err) {
      if (err instanceof HostedWorkerCompositionError) {
        // A misconfigured hosted deploy is exactly the incident nobody sees
        // without error tracking; Sentry groups the flood into one issue.
        reportError(err, { tags: { source: "worker_composition" } })
        return compositionErrorResponse(err)
      }
      throw err
    }
    // Pass the ExecutionContext through so routes can `waitUntil` background
    // work (telemetry, lifecycle touch) past the response.
    return app.fetch(request, env, ctx)
  },

  // D13 reaper, driver-side half (ops floor ADR 016 §4 Decision 3): the Cron
  // Trigger in wrangler.toml drives the EXISTING sandbox GC path — a synthetic
  // request to the admin route, authorized with the same admin token — so the
  // scheduled sweep and the manual break-glass curl exercise the exact same
  // code (`sandboxManager.garbageCollect()`, including its telemetry capture).
  // The Convex-side half (lease-table sweep) runs in convex/crons.ts. Every
  // failure here (missing config, missing token, non-2xx GC) THROWS so the
  // cron invocation is recorded as failed and reaches Sentry via withSentry —
  // a silently-dead reaper is the failure mode this design exists to avoid.
  async scheduled(_controller: ScheduledController, env: HostedWorkerEnv, ctx?: ExecutionContext): Promise<void> {
    // F17 (adversarial review): the sandbox GC sweep and the billing
    // reconciliation sweep are ISOLATED — a throwing/failing GC pass must not
    // starve the billing sweep (the downgrade-recovery + deleted-org "bills
    // forever" paths). Each runs under its own try/catch; the GC failure is
    // captured and RE-THROWN after billing runs so the cron invocation is still
    // recorded as failed and reaches Sentry via withSentry (a silently-dead
    // reaper is the money leak this design exists to avoid).
    let gcError: unknown
    try {
      const app = buildApp(env)
      const token = env.CLAXEDO_RUNTIME_ADMIN_TOKEN?.trim()
      if (!token) {
        throw new Error("Sandbox reconciliation cron requires CLAXEDO_RUNTIME_ADMIN_TOKEN")
      }
      const response = await app.fetch(
        new Request("https://control-plane.cron.internal/internal/sandbox-manager/gc", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
        ctx,
      )
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(`Sandbox reconciliation cron failed: ${response.status} ${detail}`.trim())
      }
    } catch (err) {
      gcError = err
    }

    // D5 billing reconciliation sweep (ADR 014 §3): re-fetch Polar customer
    // state for orgs the Convex cron flagged as stale and re-apply it through
    // the single writer. Runs INDEPENDENTLY of the GC outcome above. Already
    // throw-free (a billing hiccup pages via reportPaymentError and the Convex
    // flag persists for the next run); wrapped anyway so a future throw here
    // cannot mask the GC failure. No-op when CLAXEDO_POLAR_ACCESS_TOKEN is
    // absent (billing not deployed).
    try {
      await runScheduledBillingReconciliation(env)
    } catch (err) {
      reportError(err, { tags: { source: "worker_scheduled", reason: "billing_sweep_failed" } })
    }

    try {
      const app = buildApp(env)
      void app
      await cached!.workGraphRuntime?.reconcile()
    } catch (err) {
      reportError(err, { tags: { source: "worker_scheduled", reason: "workgraph_reconcile_failed" } })
      if (!gcError) gcError = err
    }

    // Surface the GC failure now that billing has had its independent run.
    if (gcError) throw gcError
  },
}

export default Sentry.withSentry(
  (env: HostedWorkerEnv) => sentryInitOptions(env, "worker"),
  handler,
)
