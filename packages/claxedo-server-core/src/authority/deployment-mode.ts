/**
 * Explicit deployment trust posture and the global unsigned-local gate.
 *
 * TWO ORTHOGONAL AXES. Conflating them is how this file's vocabulary drifted:
 *
 * - TRUST (`local` | `hosted`, this module) — how requests are authenticated.
 * - RUNTIME (`node` | `workerd`, see `deploymentRuntime`) — where it executes.
 *
 * "Self-hosting" is neither: it describes WHO OPERATES the deployment, and is
 * documentation vocabulary only, never a value here. A user self-hosting on a
 * public domain with signed auth is `trust=hosted, runtime=node` — a real shape
 * the old `self-host | hosted` enum could not express, which is why
 * `public-docs` had to warn operators away from the word "hosted" while
 * documenting a hosted remote deployment on Fly.
 *
 * Without an explicit posture, "hosted" would be an emergent property of which
 * env vars happen to be set. This module makes the deployment's trust posture
 * an explicit fact the system knows:
 *
 * - `CLAXEDO_DEPLOYMENT_MODE=local` (default when absent) keeps today's
 *   behavior bit-for-bit: zero-config boot, unsigned, loopback-guarded.
 *   The OSS quickstart never sets the flag.
 * - `CLAXEDO_DEPLOYMENT_MODE=hosted` declares the signed multi-tenant posture.
 *
 * This module owns PARSING that posture and the request-time guard below —
 * nothing else. Hosted BOOT prerequisites belong to each composition root,
 * which is the only layer that knows its own dependencies: the self-hosted
 * Node app refuses `hosted` outright (`hosted_composition_removed`), and the
 * certified Better Auth + D1 worker validates its own bindings in
 * `better-auth-d1-compose.ts`. A generic boot assertion here could only
 * restate env names no composition reads.
 *
 * NO BACKWARD COMPATIBILITY: the former `self-host` value is invalid and throws
 * at boot naming `local`. An accepted-but-deprecated alias would reintroduce
 * exactly the silent-drift surface this rename removes.
 *
 * The request-time counterpart is `unsignedLocalRequestGuard`: one global
 * middleware at the app-composition root that is the PRIMARY unsigned-local
 * gate. The scattered per-route `isLoopbackLocalRequest` checks
 * (connections-host gate, routes/events.ts `allowLoopbackLocal`, the
 * local-only projections) remain in place but are demoted to
 * defense-in-depth.
 *
 * Worker-safe: no node:* imports (`local-only-projection` is on the
 * Worker-safe list) — `hosted-app.ts` mounts the guard too.
 */

import type { MiddlewareHandler } from "hono"
import type { ControlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"

export const DEPLOYMENT_MODE_ENV = "CLAXEDO_DEPLOYMENT_MODE"

/**
 * Trust posture: how requests are authenticated. Orthogonal to `DeploymentRuntime`.
 */
export type Trust = "local" | "hosted"

/**
 * Execution runtime. Derived at each composition root (worker.ts -> "workerd";
 * main.ts / hosted-node.ts -> "node"), never read from the environment, so it
 * adds no operator surface. Exists so `node-hosted` and `workerd-hosted` are
 * distinguishable — "hosted" alone says nothing about where code runs.
 */
export type DeploymentRuntime = "node" | "workerd"

export type DeploymentEnv = Record<string, string | undefined>

export class DeploymentModeError extends Error {
  constructor(
    public readonly code: "deployment_mode_invalid",
    message: string,
  ) {
    super(message)
  }
}

function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

/**
 * Resolve the trust posture. Absent/blank = `local` (zero-config DX unchanged).
 * Any other value throws: a typo in a deploy manifest must be a boot failure,
 * not a silent fallback to the open posture.
 *
 * The retired `self-host` value is called out by name in the error, because
 * that is the one stale value an existing deployment is likely to carry.
 */
export function deploymentMode(env: DeploymentEnv = process.env): Trust {
  const raw = clean(env[DEPLOYMENT_MODE_ENV])?.toLowerCase()
  if (!raw || raw === "local") return "local"
  if (raw === "hosted") return "hosted"
  if (raw === "self-host") {
    throw new DeploymentModeError(
      "deployment_mode_invalid",
      `${DEPLOYMENT_MODE_ENV}="self-host" was renamed to "local". Self-hosting describes who ` +
        "operates a deployment, not how its requests are authenticated — a self-hosted instance " +
        'with signed auth is "hosted". Unset the variable, or set it to "local", for the ' +
        "unsigned loopback-only posture.",
    )
  }
  throw new DeploymentModeError(
    "deployment_mode_invalid",
    `${DEPLOYMENT_MODE_ENV} must be "local" or "hosted"; got "${raw}". ` +
      "Unset it (or set local) for the zero-config unsigned posture; set hosted only in hosted deploy manifests.",
  )
}

type AllowlistEntry = {
  method?: string
  exact?: string
  prefix?: string
  /** Why this route may be reached by a non-loopback caller in unsigned local mode. */
  why: string
}

/**
 * The explicit, auditable allowlist of routes that stay reachable for a
 * NON-loopback caller in unsigned local mode. Every entry must carry its
 * own gate — the guard is not that gate, it only documents why the route may
 * opt out of it. (Design doc: "an allowlist of exceptions is auditable; a
 * scatter of guards is not.")
 */
export const UNSIGNED_NONLOOPBACK_ALLOWLIST: readonly AllowlistEntry[] = [
  { method: "GET", exact: "/api/claxedo/health", why: "deploy/load-balancer health probes; returns no user data" },
  { method: "GET", exact: "/global/health", why: "deploy/load-balancer health probes; returns no user data" },
  { method: "GET", exact: "/.well-known/jwks.json", why: "public verification keys consumed by relay/runtime verifiers" },
  {
    method: "GET",
    exact: "/api/claxedo/integrations/callback",
    why: "OAuth provider redirect arrives via the user's browser; single-use TTL attempt state is the gate (connections kit routes.ts)",
  },
  { prefix: "/internal/relay/", why: "relay resolver machine path; the resolver token is the gate" },
  { prefix: "/internal/sandbox-manager/", why: "sandbox admin machine path; CLAXEDO_RUNTIME_ADMIN_TOKEN is the gate" },
  { prefix: "/api/channels/", why: "channel ingress webhooks arrive from providers; per-channel secret/signature verification is the gate" },
]

function allowlisted(method: string, pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  for (const entry of UNSIGNED_NONLOOPBACK_ALLOWLIST) {
    if (entry.method && entry.method !== method) continue
    if (entry.exact && entry.exact === path) return true
    if (entry.prefix && pathname.startsWith(entry.prefix)) return true
  }
  return false
}

export type UnsignedLocalGuardOptions = {
  mode: Trust
  authConfig: ControlPlaneAuthConfig
}

function guardBody(code: string, message: string) {
  return { error: { code, message } }
}

/**
 * The ONE global unsigned-local gate, mounted at the app-composition root
 * before every route handler (both `server.ts createApp` and
 * `hosted-app.ts createHostedApp`). Policy:
 *
 * - Signed deployment (`authConfig.enabled`): pass through — per-route bearer
 *   verification (`controlPlaneAuthContext`) is the gate, exactly as today.
 * - Hosted + not signed: 503 for EVERYTHING (loopback included). Nothing in
 *   this module rules that state out — hosted prerequisites are each
 *   composition root's own business — so this branch is the real last line
 *   of defense: a hosted deployment that reaches serving without signed auth
 *   is DOWN, not open.
 * - Self-host unsigned: loopback requests pass (today's behavior,
 *   bit-for-bit); non-loopback requests are DENIED unless explicitly
 *   allowlisted above. `misconfigured` (signed requested but broken) answers
 *   503 to non-loopback like the per-route auth path always has.
 */
export function unsignedLocalRequestGuard(options: UnsignedLocalGuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (options.authConfig.enabled) return next()
    if (options.mode === "hosted") {
      return c.json(
        guardBody(
          "hosted_unsigned_rejected",
          "hosted deployment refuses unsigned requests: signed auth is not configured",
        ),
        503,
      )
    }
    if (allowlisted(c.req.method, new URL(c.req.url).pathname)) return next()
    if (isLoopbackLocalRequest(c.req.raw)) return next()
    if (options.authConfig.mode === "misconfigured") {
      return c.json(guardBody("signed_cloud_auth_disabled", options.authConfig.reason), 503)
    }
    return c.json(
      guardBody(
        "unsigned_local_loopback_required",
        "unsigned-local access is loopback-only; set CLAXEDO_EMBEDDED_AUTH=1 to configure signed auth for remote access",
      ),
      403,
    )
  }
}
