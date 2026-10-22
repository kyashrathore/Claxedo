import type { D1Database } from "@cloudflare/workers-types"
import { timedD1, timedFetch, timedResponse } from "../../platform/http/server-timing"
import { echoesD1Bookmarks, inD1Sessions, requestSessionD1, type D1SessionStart } from "../../platform/db/d1-sessions"
import { carriesSessionCookie } from "../../platform/auth/session-cookie"
import { USER_DEPLOYED_OWNER_CLAIM_HEADER } from "../../authority/adapters/d1/owner-identity"
import type { ExecutionContext } from "hono"
import {
  requestIsHttps,
  securityHeaderEntries,
  withApiResponseHeaders,
  withSecurityHeaders,
} from "@claxedo/server-core/platform/http/security-headers"

import {
  composeBetterAuthD1UserDeployedControlPlane,
  type BetterAuthD1UserDeployedComposition,
  type BetterAuthD1UserDeployedCompositionInput,
} from "../../authority/adapters/worker/better-auth-d1-compose"
import type { HostedWorkerEnv } from "../../authority/provider-neutral-hosted-services"
import { cloudflareAuthEmailSender, type CloudflareEmailBinding } from "../../platform/auth/auth-email-delivery"
import { resolveBetterAuthConfiguration } from "../../platform/auth/better-auth-configuration"
import { retireExpiredVerifications } from "../../platform/auth/better-auth-d1-foundation"
import {
  cloudflareRateLimitStore,
  createFixedWindowConnectionRateLimiter,
  createLayeredRateLimiter,
  type ConnectionRateLimiter,
} from "../../platform/auth/rate-limit"
import { requestClientKeyFromHeaders } from "../../platform/auth/request-guard"
import { createHostedCoreWorker, LiveSyncRoom, type HostedCoreWorkerEnv } from "./core-worker.cf"
import { settledCompositionCache, type CompositionLifetime } from "./settled-composition-cache"

export { LiveSyncRoom }

/** The writer as the edge Worker's service binding reaches it. */
export type ControlPlaneWriter = { fetch(request: Request): Promise<Response> }

export type BetterAuthD1WorkerEnv = HostedCoreWorkerEnv & {
  /**
   * `on` when the deployment reads at the edge: both Workers run every
   * request's statements in D1 sessions and hand bookmarks on. Unset, the
   * one Worker reads the bare bindings, as D1 runs them, on the primary.
   */
  CLAXEDO_D1_EDGE_READS?: string
  /** Bound only on the edge Worker: the writer every `primary` request is handed to. */
  CONTROL_PLANE_WRITER?: ControlPlaneWriter
  EMAIL?: CloudflareEmailBinding
  CLAXEDO_EMAIL_FROM?: string
  AUTH_DB: D1Database
  CONTROL_PLANE_DB: D1Database
  CF_VERSION_METADATA?: { id?: string; tag?: string }
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID?: string
  CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME?: string
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

function readsAtTheEdge(env: Pick<BetterAuthD1WorkerEnv, "CLAXEDO_D1_EDGE_READS">) {
  return env.CLAXEDO_D1_EDGE_READS === "on"
}

/**
 * The two databases as every composition of this Worker reads them, timed;
 * when the deployment reads at the edge, through the current request's D1
 * session (`inD1Sessions` below). A path that reached a bare binding there
 * would run outside the session, so its writes would be missing from the
 * bookmark the client carries away.
 */
export function workerDatabases(env: Pick<BetterAuthD1WorkerEnv, "AUTH_DB" | "CONTROL_PLANE_DB" | "CLAXEDO_D1_EDGE_READS">) {
  if (!readsAtTheEdge(env)) return { auth: timedD1(env.AUTH_DB), controlPlane: timedD1(env.CONTROL_PLANE_DB) }
  return {
    auth: timedD1(requestSessionD1(env.AUTH_DB, "auth")),
    controlPlane: timedD1(requestSessionD1(env.CONTROL_PLANE_DB, "control")),
  }
}

/** The base user-deployed composition input; feature entries extend the result, never this. */
export function betterAuthD1CompositionInput(env: BetterAuthD1WorkerEnv): BetterAuthD1UserDeployedCompositionInput {
  const databases = workerDatabases(env)
  return {
    env: stringEnvironment(env),
    emailSender: cloudflareAuthEmailSender(env),
    authDatabase: databases.auth,
    controlPlaneDatabase: databases.controlPlane,
    fetch: timedFetch(),
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
 * The auth routes that consume a single-use verification row in this
 * deployment: the OAuth callback's state and the password reset's token.
 */
function consumesVerification(pathname: string) {
  return pathname.startsWith("/api/auth/callback/") || pathname.startsWith("/api/auth/reset-password")
}

/**
 * The reads that run on the writer although a bookmark-carrying browser may
 * send them, each because it writes what its own next request reads, decides
 * on a row another actor wrote moments before with no bookmark to hand on,
 * or spends a single-use credential:
 * - the OAuth callback and password reset consume a verification row, and
 *   the sign-in after them must see the session;
 * - email verification and account deletion confirm a link, and an OAuth
 *   client's sign-out ends the session the next request must not find;
 * - the device page finds the code a CLI just asked for;
 * - an authorization finds the client an MCP client just registered, and
 *   writes the code it exchanges;
 * - a connection attempt's poll advances a device grant whose last answer
 *   the previous poll wrote, and a connection's token and repositories may
 *   renew its OAuth token, whose refresh token works once;
 * - the plugin MCP gateway and the egress broker renew vendor credentials;
 * - the relay's resolver checks revocation and serving generations the
 *   moment after they are written;
 * - a machine's doorbell stream is admitted by its signature, which consumes
 *   the request's nonce, a write, before the writer holds the stream open.
 * `d1-session-classifier.test.ts` holds every GET route either here or in
 * its reviewed list of replica reads, so a new one is classified on purpose.
 */
export const PRIMARY_READS = [
  "/api/auth/callback/",
  "/api/auth/reset-password",
  "/api/auth/verify-email",
  "/api/auth/delete-user/callback",
  "/api/auth/oauth2/end-session",
  "/api/auth/device",
  "/api/auth/oauth2/authorize",
  "/api/claxedo/integrations/callback",
  "/api/claxedo/integrations/attempts/",
  "/api/claxedo/integrations/connections/",
  "/api/claxedo/host/enrollments/events",
  "/api/claxedo/plugins/mcp/",
  "/bindings/",
  "/internal/",
]

/**
 * Where a request runs and where its D1 sessions start: the one classifier
 * the edge Worker forwards by and both Workers open their sessions by.
 *
 * `replica`: a read the edge answers itself, from the nearest replica no
 * older than the bookmarks it carries. That is a read from the browser,
 * whose signed requests carry its cookie jar; from a client that echoes the
 * bookmark header; or from nobody at all (the health probe, the descriptor,
 * public metadata), which has no writes of its own to miss.
 *
 * `primary`: everything the writer runs beside the primary, so the reads it
 * decides on see every committed write and the bookmark it hands back covers
 * what it wrote: every method that may write, the reads in `PRIMARY_READS`,
 * a request redeeming an owner claim (a row the deploy wrote on the
 * primary), and a read on a bearer token that echoes no bookmark (a machine,
 * the relay, a sandbox, the desktop's first call), whose caller would carry
 * nothing of its own writes into a replica.
 */
export function d1SessionStart(request: Request): D1SessionStart {
  if (request.method !== "GET" && request.method !== "HEAD") return "primary"
  const pathname = new URL(request.url).pathname
  if (PRIMARY_READS.some((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return "primary"
  if (request.headers.has(USER_DEPLOYED_OWNER_CLAIM_HEADER)) return "primary"
  if (carriesSessionCookie(request.headers.get("cookie")) || echoesD1Bookmarks(request)) return "replica"
  return request.headers.has("authorization") ? "primary" : "replica"
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
function unavailable(request: Request) {
  return withSecurityHeaders(
    Response.json({ error: { code: "deployment_candidate_unavailable" } }, { status: 503 }),
    requestSecurityHeaderEntries(request),
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

/**
 * Hands a request to the writer before anything on the edge composes,
 * authenticates or rate-limits it, so the writer does each once. The
 * writer's answer keeps its own `Server-Timing`; `forward` adds the wait on
 * it, the hop to the writer's data center included.
 */
async function forwardToWriter(writer: ControlPlaneWriter, request: Request) {
  const started = performance.now()
  let response: Response
  try {
    response = await writer.fetch(request)
  } catch (error) {
    console.error("[better-auth-d1] the writer did not answer", error)
    return unavailable(request)
  }
  const timing = `forward;dur=${(performance.now() - started).toFixed(1)}`
  try {
    response.headers.append("server-timing", timing)
    return response
  } catch {
    const rebuilt = new Response(response.body, response)
    rebuilt.headers.append("server-timing", timing)
    return rebuilt
  }
}

function rateLimitedResponse(request: Request, retryAfterMs: number) {
  return withSecurityHeaders(
    Response.json(
      { error: { code: "rate_limited", message: "Request limit exceeded", retryAfterMs } },
      { status: 429 },
    ),
    [...requestSecurityHeaderEntries(request), ["retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000)))]],
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
  composition: (env: BetterAuthD1WorkerEnv, lifetime?: CompositionLifetime) => BetterAuthD1UserDeployedComposition
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
  const core = createHostedCoreWorker<BetterAuthD1WorkerEnv>((env, lifetime) => {
    const selected = composition(env, lifetime)
    return { plane: selected.plane, options: selected.options, documentAccess: selected.documentAccess }
  })

  return {
    fetch(request: Request, env: BetterAuthD1WorkerEnv, context?: ExecutionContext) {
      if (!readsAtTheEdge(env)) return timedResponse(request, () => respond(request, env, context))
      const start = d1SessionStart(request)
      if (start === "primary" && env.CONTROL_PLANE_WRITER) return forwardToWriter(env.CONTROL_PLANE_WRITER, request)
      return timedResponse(request, () => inD1Sessions(request, start, () => respond(request, env, context)))
    },
  }

  async function respond(request: Request, env: BetterAuthD1WorkerEnv, context?: ExecutionContext) {
    try {
      if (!env.AUTH_DB || !env.CONTROL_PLANE_DB) throw new Error("AUTH_DB and CONTROL_PLANE_DB are required")
      const configured = resolveBetterAuthConfiguration({ env: stringEnvironment(env), emailSender: cloudflareAuthEmailSender(env) })
      const url = new URL(request.url)
      if (url.origin !== configured.public.origin)
        throw new Error("observed request origin does not match BETTER_AUTH_URL")
      if (authRoute(url.pathname)) {
        const decision = await createPublicAuthRateLimiter(env, publicAuthRateLimiter).check({
          key: `public-auth:${requestClientKeyFromHeaders(request.headers)}`,
        })
        if (!decision.allowed) return rateLimitedResponse(request, decision.retryAfterMs)
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
      // The core composes for itself inside `core.fetch`; composing here as
      // well built every cold core request's control plane twice, since the
      // first instance is not reusable until its readiness reads settle.
      if (authRoute(url.pathname)) {
        const response = await composition(env, context).authHandler(request)
        if (consumesVerification(url.pathname)) context?.waitUntil(retireExpiredVerifications(env.AUTH_DB))
        return withApiResponseHeaders(response, {
          url: request.url,
          header: (name) => request.headers.get(name) ?? undefined,
        })
      }
      return await core.fetch(request, env, context)
    } catch (error) {
      console.error("[better-auth-d1] deployment is unavailable", error)
      return unavailable(request)
    }
  }
}

const handler = createBetterAuthD1Worker({ composition: defaultComposition })

export default handler
