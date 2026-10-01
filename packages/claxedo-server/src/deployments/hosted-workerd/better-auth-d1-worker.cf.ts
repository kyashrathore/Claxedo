import type { D1Database } from "@cloudflare/workers-types"
import type { ExecutionContext } from "hono"
import {
  requestIsHttps,
  securityHeaderEntries,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"
import { BROWSER_ALLOWED_REQUEST_HEADERS } from "@claxedo/server-core/platform/http/browser-auth-security"
import { configuredCoreAppOrigins } from "../hosted-shared/hosted-core-app"

import {
  composeBetterAuthD1UserDeployedControlPlane,
  type BetterAuthD1UserDeployedComposition,
  type BetterAuthD1UserDeployedCompositionInput,
} from "../../authority/adapters/worker/better-auth-d1-compose"
import type { HostedWorkerEnv } from "../../authority/provider-neutral-hosted-services"
import { resolveBetterAuthConfiguration } from "../../platform/auth/better-auth-configuration"
import {
  cloudflareRateLimitStore,
  createFixedWindowConnectionRateLimiter,
  createLayeredRateLimiter,
  type ConnectionRateLimiter,
} from "../../platform/auth/rate-limit"
import { requestClientKeyFromHeaders } from "../../platform/auth/request-guard"
import { createHostedCoreWorker, LiveSyncRoom, type HostedCoreWorkerEnv } from "./core-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"

export { LiveSyncRoom }

export type BetterAuthD1WorkerEnv = HostedCoreWorkerEnv & {
  AUTH_DB: D1Database
  CONTROL_PLANE_DB: D1Database
  CF_VERSION_METADATA?: { id?: string; tag?: string }
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID?: string
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME?: string
  /**
   * The browser app origins (comma-separated; `https://*.suffix` allowed).
   * A refusal answers these with CORS headers so an unavailable deployment
   * reads as a 503 with a code in the app, not as "Failed to fetch".
   */
  CLAXEDO_APP_ORIGINS?: string
  CLAXEDO_APP_ORIGIN?: string
}

/**
 * How long a composed auth descriptor tells clients it stays valid. The
 * descriptor is built once per composition and a composition lives as long
 * as its isolate, so this must outlast any isolate: Cloudflare replaces
 * isolates on every deploy and recycles idle ones within hours.
 */
const AUTH_DESCRIPTOR_TTL_MS = 30 * 24 * 60 * 60 * 1000

function stringEnvironment(env: BetterAuthD1WorkerEnv): HostedWorkerEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function requiredSetting(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

/** The base user-deployed composition input; feature entries extend the result, never this. */
export function betterAuthD1CompositionInput(env: BetterAuthD1WorkerEnv): BetterAuthD1UserDeployedCompositionInput {
  return {
    env: stringEnvironment(env),
    authDatabase: env.AUTH_DB,
    controlPlaneDatabase: env.CONTROL_PLANE_DB,
    descriptorExpiresAt: Date.now() + AUTH_DESCRIPTOR_TTL_MS,
    product: {
      kind: "user-deployed",
      organization: {
        id: requiredSetting(env.CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID, "CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID"),
        name: requiredSetting(env.CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME, "CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME"),
      },
      ownerBootstrap: "one-use-claim",
    },
  }
}

// Reused across requests only once Better Auth's init has settled; until
// then every request builds its own instance so a canceled first request
// cannot wedge the isolate (see settled-composition-cache.ts).
const defaultComposition = settledCompositionCache(
  (env: BetterAuthD1WorkerEnv): BetterAuthD1UserDeployedComposition =>
    composeBetterAuthD1UserDeployedControlPlane(betterAuthD1CompositionInput(env)),
  (created) => created.authReady,
)

function authRoute(pathname: string) {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/")
  )
}

/**
 * CORS for a refusal.
 *
 * A served request answers the app origin with CORS through the core app's
 * own middleware; a refusal answers before that middleware exists. Without
 * these headers the browser hides the 503 and its code behind "Failed to
 * fetch". Same origin rule as the core app.
 */
function refusalCorsEntries(
  request: Request,
  env: { CLAXEDO_APP_ORIGINS?: string; CLAXEDO_APP_ORIGIN?: string },
): ReadonlyArray<readonly [string, string]> {
  const origin = request.headers.get("origin")
  if (!origin) return []
  const allowed = configuredCoreAppOrigins(env.CLAXEDO_APP_ORIGINS ?? env.CLAXEDO_APP_ORIGIN)
  if (!allowed(origin)) return []
  return [
    ["access-control-allow-origin", origin],
    ["access-control-allow-credentials", "true"],
    ["access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS"],
    ["access-control-allow-headers", BROWSER_ALLOWED_REQUEST_HEADERS.join(", ")],
    ["vary", "origin"],
  ]
}

function requestSecurityHeaderEntries(request: Request) {
  return securityHeaderEntries({
    https: requestIsHttps({ url: request.url, header: (name) => request.headers.get(name) ?? undefined }),
  })
}

/**
 * `deployment_candidate_unavailable` is the code host connectors and the
 * desktop app already treat as a transient deploy window and retry.
 */
function unavailable(request: Request, cors: ReadonlyArray<readonly [string, string]>) {
  // The preflight must succeed for the browser to send the real request and
  // read the 503 it gets back.
  if (request.method === "OPTIONS" && cors.length) {
    return withSecurityHeaders(new Response(null, { status: 204 }), cors)
  }
  return withSecurityHeaders(
    Response.json({ error: { code: "deployment_candidate_unavailable" } }, { status: 503 }),
    [...requestSecurityHeaderEntries(request), ...cors],
  )
}

// Auth traffic is dispatched to `selected.authHandler` below, ahead of the
// core app — so the core app's `defaultRequestGuard` never sees it. The
// public-auth budget therefore lives at this boundary: the same per-client
// ceiling product requests get. The shared layer is the CLAXEDO_REQUEST_LIMITER
// binding (600/60s in the generated wrangler config); the local fuse and its
// window agree with that period so the two layers mean the same minute.
const PUBLIC_AUTH_RATE_LIMIT = 600
const PUBLIC_AUTH_RATE_LIMIT_WINDOW_MS = 60_000

/**
 * The budget check itself. Keyed on the edge-stamped client IP
 * (`requestClientKeyFromHeaders` prefers `cf-connecting-ip`, which a client
 * cannot supply on the Worker path) — never leftmost `x-forwarded-for`, which
 * is client-controlled and would mint a fresh bucket per request. The
 * `public-auth:` prefix keeps this bucket distinct from the product limiter's
 * on the shared binding.
 */
function createPublicAuthRateLimiter(env: BetterAuthD1WorkerEnv, local: ConnectionRateLimiter) {
  return createLayeredRateLimiter({
    local,
    ...(env.CLAXEDO_REQUEST_LIMITER
      ? {
          sharedStore: cloudflareRateLimitStore(env.CLAXEDO_REQUEST_LIMITER, {
            periodSeconds: PUBLIC_AUTH_RATE_LIMIT_WINDOW_MS / 1000,
          }),
        }
      : {}),
  })
}

function rateLimitedResponse(
  request: Request,
  cors: ReadonlyArray<readonly [string, string]>,
  retryAfterMs: number,
) {
  return withSecurityHeaders(
    Response.json(
      { error: { code: "rate_limited", message: "Request limit exceeded", retryAfterMs } },
      { status: 429 },
    ),
    [
      ...requestSecurityHeaderEntries(request),
      ["retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000)))],
      ...cors,
    ],
  )
}

/**
 * The user-deployed Worker over a statically selected composition.
 *
 * The base artifact passes the plain user-deployed composition; a feature
 * artifact (Agent Plugins) passes the same composition extended with its
 * route contributions and runtime hooks, so the request boundary — origin
 * check, public-auth budget, deploy health, auth dispatch — cannot drift
 * between artifacts.
 */
export function createBetterAuthD1Worker(input: {
  composition: (env: BetterAuthD1WorkerEnv) => BetterAuthD1UserDeployedComposition
  /**
   * Per-isolate fuse for the public-auth budget. Tests pass a smaller limit;
   * entries leave it unset — buckets live inside the limiter, so the default
   * must be created once per worker, not per request.
   */
  publicAuthRateLimiter?: ConnectionRateLimiter
}) {
  const composition = input.composition
  const publicAuthRateLimiter =
    input.publicAuthRateLimiter ??
    createFixedWindowConnectionRateLimiter({
      limit: PUBLIC_AUTH_RATE_LIMIT,
      windowMs: PUBLIC_AUTH_RATE_LIMIT_WINDOW_MS,
    })
  const core = createHostedCoreWorker<BetterAuthD1WorkerEnv>((env) => {
    const selected = composition(env)
    return { plane: selected.plane, options: selected.options }
  })

  return {
    async fetch(request: Request, env: BetterAuthD1WorkerEnv, context?: ExecutionContext) {
      const cors = refusalCorsEntries(request, env)
      try {
        if (!env.AUTH_DB || !env.CONTROL_PLANE_DB) throw new Error("AUTH_DB and CONTROL_PLANE_DB are required")
        const configured = resolveBetterAuthConfiguration({ env: stringEnvironment(env) })
        const url = new URL(request.url)
        if (url.origin !== configured.public.apiOrigin)
          throw new Error("observed request origin does not match BETTER_AUTH_URL")
        if (authRoute(url.pathname)) {
          const decision = await createPublicAuthRateLimiter(env, publicAuthRateLimiter).check({
            key: `public-auth:${requestClientKeyFromHeaders(request.headers)}`,
          })
          if (!decision.allowed) return rateLimitedResponse(request, cors, decision.retryAfterMs)
        }
        // The deploy command polls this until it names the version it just
        // deployed, so it answers before composition and reads no database.
        if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
          return withSecurityHeaders(
            Response.json({
              status: "ok",
              platformVersionId: requiredSetting(env.CF_VERSION_METADATA?.id, "CF_VERSION_METADATA.id"),
              platformVersionTag: env.CF_VERSION_METADATA?.tag || null,
            }),
            requestSecurityHeaderEntries(request),
          )
        }
        const selected = composition(env)
        if (authRoute(url.pathname)) return await selected.authHandler(request)
        return await core.fetch(request, env, context)
      } catch (error) {
        console.error("[better-auth-d1] deployment is unavailable", error)
        return unavailable(request, cors)
      }
    },
  }
}

const handler = createBetterAuthD1Worker({ composition: defaultComposition })

export default handler
