/**
 * Provider-independent Cloudflare Worker root for the hosted core.
 *
 * Certified product/profile entrypoints inject exactly one static composition
 * through `createHostedCoreWorker`. This module owns the Cloudflare-only core
 * resources shared by every profile: the cross-isolate request limiter and
 * `LIVE_SYNC_ROOM`. Optional services are reached only through the typed
 * service catalog consumed by `HostedCoreAppOptions`; their implementations,
 * storage, jobs, and Durable Objects never enter this graph.
 *
 * The historical `worker.ts` entry remains a legacy deployment target until
 * its WorkGraph/Wake namespaces have been archived and drained. Keeping that
 * entry separate is deliberate: rewriting its existing Wrangler migration
 * tags would corrupt Cloudflare's Durable Object migration history.
 */

import type { ExecutionContext, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"

import type { HostedControlPlane } from "../../authority/hosted-services"
import { HostedWorkerCompositionError } from "../../authority/composition-error"
import {
  cloudflareRateLimitStore,
  type CloudflareRateLimitBinding,
} from "../../platform/auth/rate-limit"
import {
  createHostedCoreApp,
  type HostedCoreAppOptions,
} from "../hosted-shared/hosted-core-app"
import { LiveSyncRoom } from "./live-sync-room.cf"
import type { LiveSyncRoomNamespace } from "../../platform/http/live-sync-publish"

export { LiveSyncRoom }

export type HostedCoreWorkerEnv = Record<string, unknown> & {
  CLAXEDO_REQUEST_LIMITER?: CloudflareRateLimitBinding
  LIVE_SYNC_ROOM?: LiveSyncRoomNamespace
}

export type HostedCoreWorkerComposition<Env extends HostedCoreWorkerEnv> = (
  env: Env,
) => {
  plane: HostedControlPlane
  options: Omit<HostedCoreAppOptions, "liveSyncRoom" | "sharedRateLimitStore">
}

function bindingError(name: string): never {
  throw new HostedWorkerCompositionError(
    "hosted_dependency_missing",
    `Hosted core requires the ${name} binding`,
  )
}

function requiredRateLimiter(value: CloudflareRateLimitBinding | undefined) {
  if (!value || typeof value.limit !== "function") bindingError("CLAXEDO_REQUEST_LIMITER")
  return value
}

function requiredLiveSyncRoom(value: LiveSyncRoomNamespace | undefined) {
  if (!value || typeof value.idFromName !== "function" || typeof value.get !== "function") {
    bindingError("LIVE_SYNC_ROOM")
  }
  return value
}

function compositionErrorResponse(error: HostedWorkerCompositionError, request: Request) {
  return withSecurityHeaders(
    Response.json({ error: { code: error.code, message: error.message } }, { status: 503 }),
    securityHeaderEntries({
      https: requestIsHttps({ url: request.url, header: (name) => request.headers.get(name) ?? undefined }),
    }),
  )
}

/**
 * Build one statically selected hosted-core Worker. There is deliberately no
 * default export here: a deployable artifact must import this factory from one
 * certified adapter/product entrypoint, so credentials or request data can
 * never select a composition at runtime.
 */
export function createHostedCoreWorker<Env extends HostedCoreWorkerEnv>(
  compose: HostedCoreWorkerComposition<Env>,
) {
  // Keyed by the composed control plane, NOT by `env`. `compose` is expected
  // to memoize with the settled-composition rule: a composition whose lazy
  // auth init never settled (its constructor request was canceled) is
  // replaced on the next call. Caching the app per `env` pinned the FIRST
  // composition for the isolate's lifetime, so a wedged foundation kept
  // serving every authenticated core route as an endless hang (2ms CPU, no
  // response) even while the auth routes — which re-ask `compose` per
  // request — had already recovered. Keying on the plane makes the app cache
  // follow the composition cache: same settled composition, same app; a
  // replaced composition gets a fresh app.
  const appByPlane = new WeakMap<object, Hono>()

  function appFor(env: Env) {
    // Mandatory bindings fail closed BEFORE any composition runs.
    const limiter = requiredRateLimiter(env.CLAXEDO_REQUEST_LIMITER)
    const liveSyncRoom = requiredLiveSyncRoom(env.LIVE_SYNC_ROOM)
    const selected = compose(env)
    const key = selected.plane as object
    const existing = appByPlane.get(key)
    if (existing) return existing

    const app = createHostedCoreApp(selected.plane, {
      ...selected.options,
      liveSyncRoom,
      sharedRateLimitStore: cloudflareRateLimitStore(limiter, { periodSeconds: 60 }),
    })
    app.onError((error, context) => {
      if (error instanceof HTTPException) return error.getResponse()
      console.error(error)
      return context.text("Internal Server Error", 500)
    })
    appByPlane.set(key, app)
    return app
  }

  return {
    async fetch(request: Request, env: Env, context?: ExecutionContext) {
      try {
        return await appFor(env).fetch(request, env, context)
      } catch (error) {
        if (error instanceof HostedWorkerCompositionError) {
          return compositionErrorResponse(error, request)
        }
        throw error
      }
    },
  }
}
