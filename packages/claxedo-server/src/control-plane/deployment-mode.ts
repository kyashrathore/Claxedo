/**
 * D9 — explicit deployment mode + the ONE global unsigned-local gate.
 * (docs/plans/2026-07-11-012-feat-cloud-subscription-launch-plan.md D9;
 *  docs/plans/2026-07-11-015-wp-tenant-hardening-design.md §4 Decision 3)
 *
 * Today "hosted" is an emergent property of which env vars happen to be set:
 * a hosted deployment that LOSES `CLAXEDO_SIGNED_CLOUD_AUTH` boots green and
 * serves every request as the trusted unsigned-local owner. This module makes
 * the deployment's identity an explicit fact the system knows:
 *
 * - `CLAXEDO_DEPLOYMENT_MODE=self-host` (default when absent) keeps today's
 *   behavior bit-for-bit: zero-config boot, unsigned-local, loopback-guarded.
 *   The OSS quickstart never sets the flag.
 * - `CLAXEDO_DEPLOYMENT_MODE=hosted` fails CLOSED at boot: the composition
 *   refuses to start unless signed auth is fully configured and a workspace
 *   authority is resolved (see `assertHostedBootRequirements`). A hosted
 *   deployment that cannot authenticate must be DOWN, not open — ordinary
 *   uptime monitoring then converts a lost env var into a visible outage
 *   instead of a silent breach.
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
import type { ControlPlaneAuthConfig } from "./auth"
import { isLoopbackLocalRequest } from "../routes/local-only-projection"

export const DEPLOYMENT_MODE_ENV = "CLAXEDO_DEPLOYMENT_MODE"

export type DeploymentMode = "self-host" | "hosted"

export type DeploymentEnv = Record<string, string | undefined>

export class DeploymentModeError extends Error {
  constructor(
    public readonly code: "deployment_mode_invalid" | "hosted_boot_requirements_missing",
    message: string,
  ) {
    super(message)
  }
}

function flagEnabled(input?: string) {
  return ["1", "true", "yes"].includes((input ?? "").trim().toLowerCase())
}

function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

/**
 * Resolve the deployment mode. Absent/blank = `self-host` (zero-config
 * self-host DX unchanged). Any value other than the two known modes throws:
 * a typo in a deploy manifest must be a boot failure, not a silent fallback
 * to the open posture.
 */
export function deploymentMode(env: DeploymentEnv = process.env): DeploymentMode {
  const raw = clean(env[DEPLOYMENT_MODE_ENV])?.toLowerCase()
  if (!raw || raw === "self-host") return "self-host"
  if (raw === "hosted") return "hosted"
  throw new DeploymentModeError(
    "deployment_mode_invalid",
    `${DEPLOYMENT_MODE_ENV} must be "self-host" or "hosted"; got "${raw}". ` +
      "Unset it (or set self-host) for the zero-config self-host posture; set hosted only in hosted deploy manifests.",
  )
}

/**
 * Enumerate every hosted boot requirement that is not met. Empty array =
 * hosted mode may boot. Each entry is a human-actionable sentence naming the
 * missing piece, so the composed boot error names ALL problems at once
 * instead of one per restart.
 */
export function hostedBootRequirementFailures(
  env: DeploymentEnv,
  input: {
    /**
     * Whether the composition root resolved a workspace authority backend.
     * This module deliberately knows no backend URL env names — the
     * composition passes the resolved presence in (same seam as
     * `controlPlaneAuthConfig`).
     */
    authorityConfigured: boolean
  },
): string[] {
  const failures: string[] = []
  if (!flagEnabled(env.CLAXEDO_SIGNED_CLOUD_AUTH)) {
    failures.push("signed cloud auth is not enabled (set CLAXEDO_SIGNED_CLOUD_AUTH=true)")
  }
  if (!clean(env.CLERK_JWT_ISSUER) && !clean(env.CLERK_ISSUER_URL)) {
    failures.push("no signed-auth token issuer (set CLERK_JWT_ISSUER)")
  }
  if (!clean(env.CLERK_JWKS_URL)) {
    failures.push("no signed-auth JWKS URL (set CLERK_JWKS_URL)")
  }
  if (!input.authorityConfigured) {
    failures.push("no workspace authority (set CLAXEDO_WORKSPACE_AUTHORITY_URL)")
  }
  if (flagEnabled(env.CLAXEDO_EMBEDDED_AUTH)) {
    // The embedded Better Auth issuer is a SELF-HOST affordance (signed mode
    // with no hosted storage backend or IdP). In hosted mode it would silently
    // displace the hosted issuer (the composition prefers it): hard conflict.
    failures.push("embedded self-host auth is enabled (unset CLAXEDO_EMBEDDED_AUTH; hosted mode requires the hosted issuer)")
  }
  return failures
}

/**
 * Hosted fail-closed boot assertion: throws a single error naming EVERY
 * missing piece when `CLAXEDO_DEPLOYMENT_MODE=hosted` cannot run signed-only.
 * With these requirements met, `controlPlaneAuthConfig` resolves enabled and
 * `unsigned-local` contexts are unreachable.
 */
export function assertHostedBootRequirements(
  env: DeploymentEnv,
  input: { authorityConfigured: boolean },
): void {
  const failures = hostedBootRequirementFailures(env, input)
  if (failures.length === 0) return
  throw new DeploymentModeError(
    "hosted_boot_requirements_missing",
    `${DEPLOYMENT_MODE_ENV}=hosted refuses to start: ${failures.join("; ")}`,
  )
}

type AllowlistEntry = {
  method?: string
  exact?: string
  prefix?: string
  /** Why this route may be reached by a non-loopback caller in unsigned self-host mode. */
  why: string
}

/**
 * The explicit, auditable allowlist of routes that stay reachable for a
 * NON-loopback caller in unsigned self-host mode. Every entry must carry its
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
  mode: DeploymentMode
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
 * - Hosted + not signed: 503 for EVERYTHING (loopback included). The boot
 *   assertion makes this unreachable in a correctly started hosted
 *   deployment; if a composition somehow reaches serving without signed
 *   auth, the deployment is down, not open.
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
          "hosted deployment refuses unsigned requests: signed auth is not configured (boot assertion should have prevented serving)",
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
        "unsigned-local access is loopback-only; configure signed auth (CLAXEDO_SIGNED_CLOUD_AUTH or CLAXEDO_EMBEDDED_AUTH=1) for remote access",
      ),
      403,
    )
  }
}
