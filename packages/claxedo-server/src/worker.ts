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
 */

import type { ExecutionContext, Hono } from "hono"
import { composeHostedControlPlane, HostedWorkerCompositionError, type HostedWorkerEnv } from "./control-plane/hosted-services"
import { createHostedApp } from "./hosted-app"

let cached: { app: Hono } | undefined

function buildApp(env: HostedWorkerEnv): Hono {
  if (cached) return cached.app
  const plane = composeHostedControlPlane(env)
  const app = createHostedApp(plane)
  cached = { app }
  return app
}

function compositionErrorResponse(err: HostedWorkerCompositionError): Response {
  // Fail closed and loud when a required hosted dependency/secret is missing.
  return Response.json(
    { error: { code: err.code, message: err.message } },
    { status: 503 },
  )
}

export default {
  async fetch(request: Request, env: HostedWorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    let app: Hono
    try {
      app = buildApp(env)
    } catch (err) {
      if (err instanceof HostedWorkerCompositionError) return compositionErrorResponse(err)
      throw err
    }
    // Pass the ExecutionContext through so routes can `waitUntil` background
    // work (telemetry, lifecycle touch) past the response.
    return app.fetch(request, env, ctx)
  },
}
