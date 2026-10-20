/**
 * Provider-independent Cloudflare Worker root for the hosted core.
 *
 * Certified product/profile entrypoints inject exactly one static composition
 * through `createHostedCoreWorker`. This module owns the Cloudflare-only core
 * resources shared by every profile: the cross-isolate request limiter,
 * `LIVE_SYNC_ROOM`, the projection-command idempotency store in
 * `CONTROL_PLANE_DB`, and the hosted Pages backend over `CLAXEDO_DOCUMENTS`.
 */

import type { D1Database } from "@cloudflare/workers-types"
import type { ExecutionContext, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"
import { keepAlivePastResponse } from "@claxedo/server-core/platform/http/background-work"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"

import type { D1AccessContext } from "../../authority/adapters/d1/access-context"
import type { HostedControlPlane } from "../../authority/hosted-services"
import { createIdempotencyCoordinator, d1ProjectionCommandIdempotency } from "../../authority/http/idempotency"
import { HostedWorkerCompositionError } from "../../authority/composition-error"
import { workerErrorCapture } from "../../platform/auth/worker-telemetry"
import { d1TransientFailure } from "../../platform/db/d1-constraint"
import {
  cloudflareRateLimitStore,
  type CloudflareRateLimitBinding,
} from "../../platform/auth/rate-limit"
import {
  createHostedCoreApp,
  type HostedCoreAppOptions,
} from "../hosted-shared/hosted-core-app"
import { mcpToolGroups, type ServerPluginBase } from "@claxedo/server-core/plugins/server-plugin"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import { LiveSyncRoom } from "./live-sync-room.cf"
import type { LiveSyncRoomNamespace } from "../../platform/http/live-sync-publish"
import { HOSTED_DOCUMENTS_PLUGIN_BASE, type R2BucketBinding } from "@claxedo/documents/hosted"
import { composeHostedDocumentsPlugin } from "../../documents/compose"

export { LiveSyncRoom }

/**
 * Every group the hosted MCP mount serves: the core groups, Documents (which
 * this Worker composes in every profile), then the entry's own plugins'. The
 * Agent Plugins catalog lists the same set, and builds it before the Worker
 * composes Documents.
 */
export function hostedMcpToolGroups(entryPlugins: readonly ServerPluginBase[]) {
  return mcpToolGroups([HOSTED_DOCUMENTS_PLUGIN_BASE, ...entryPlugins])
}

export type HostedCoreWorkerEnv = Record<string, unknown> & {
  CLAXEDO_DOCUMENTS?: R2BucketBinding
  CONTROL_PLANE_DB?: D1Database
  CLAXEDO_REQUEST_LIMITER?: CloudflareRateLimitBinding
  LIVE_SYNC_ROOM?: LiveSyncRoomNamespace
}

export type HostedCoreWorkerComposition<Env extends HostedCoreWorkerEnv> = (
  env: Env,
) => {
  plane: HostedControlPlane
  options: Omit<HostedCoreAppOptions, "liveSyncRoom" | "sharedRateLimitStore" | "idempotency">
  documentAccess: D1AccessContext
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

function requiredControlPlaneDatabase(value: D1Database | undefined) {
  if (!value || typeof value.prepare !== "function") bindingError("CONTROL_PLANE_DB")
  return value
}

function requiredDocumentsBucket(value: R2BucketBinding | undefined) {
  if (!value || typeof value.get !== "function" || typeof value.put !== "function") bindingError("CLAXEDO_DOCUMENTS")
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
    const controlPlaneDatabase = requiredControlPlaneDatabase(env.CONTROL_PLANE_DB)
    const documentsBucket = requiredDocumentsBucket(env.CLAXEDO_DOCUMENTS)
    const selected = compose(env)
    const key = selected.plane as object
    const existing = appByPlane.get(key)
    if (existing) return existing

    const sharedRateLimitStore = cloudflareRateLimitStore(limiter, { periodSeconds: 60 })
    const documents = composeHostedDocumentsPlugin({
      bucket: documentsBucket,
      plane: selected.plane,
      access: selected.documentAccess,
      authentication: selected.options.authentication,
      rateLimit: async (key) => (await sharedRateLimitStore.check(key)).allowed,
    })
    const plugins = [documents, ...(selected.options.plugins ?? [])]
    const app = createHostedCoreApp(selected.plane, {
      ...selected.options,
      plugins,
      idempotency: createIdempotencyCoordinator(d1ProjectionCommandIdempotency(controlPlaneDatabase)),
      liveSyncRoom,
      sharedRateLimitStore,
      // Every profile serves the same endpoint: the control plane runs no
      // workspace itself, so its client reaches each workspace's runtime
      // through the relay with the caller's own credential.
      firstPartyMcp: {
        createClient: (input) => createClaxedoMcpClient(input),
        registerTools: hostedMcpToolGroups(selected.options.plugins ?? []),
      },
    })
    const errors = workerErrorCapture(selected.plane.env)
    app.onError((error, context) => {
      if (error instanceof HTTPException) return error.getResponse()
      console.error(error)
      keepAlivePastResponse(context, errors.captureException(error, "system", {
        route: context.req.routePath,
        method: context.req.method,
        ...(isClaxedoError(error) ? { code: error.code } : {}),
      }))
      if (d1TransientFailure(error)) {
        return context.json({ error: { code: "database_unavailable", message: "The database did not answer. Try again.", retryable: true } }, 503)
      }
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
