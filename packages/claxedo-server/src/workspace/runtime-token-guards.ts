import type { SignedControlPlaneAuth } from "../platform/auth/auth"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority, type WorkspaceAuthority } from "../platform/auth/authority"
import { apiError, rec, txt } from "./route-support"

export async function runtimeTokenOrgId(
  authority: WorkspaceAuthority,
  auth: SignedControlPlaneAuth,
  workspace: unknown,
) {
  const row = rec(workspace)
  const fromWorkspace = txt(row?.org_id) ?? txt(row?.orgId)
  if (fromWorkspace) return fromWorkspace
  if (typeof authority.resolveOrgId === "function") return await authority.resolveOrgId(auth)
  return auth.user.orgId ?? auth.user.subject
}

export async function previousRuntimeAccessTokenError(
  services: ControlPlaneServices | undefined,
  auth: SignedControlPlaneAuth,
  input: {
    previousJti?: string
    workspaceId: string
    hostId: string
  },
) {
  if (!input.previousJti) return
  const authority = requireAuthority(services)
  const active = await authority.runtimeAccessTokenActive({
    jti: input.previousJti,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
  })
  const activeRecord = rec(active)
  if (activeRecord?.active === true) return
  await authority.auditDeny(auth, {
    action: "runtime_access_token.refresh.denied",
    reason: txt(activeRecord?.code) ?? "runtime_access_token_inactive",
    workspaceId: input.workspaceId,
    metadata: {
      jti: input.previousJti,
      hostId: input.hostId,
    },
  })
  return {
    error: apiError(
      txt(activeRecord?.code) ?? "runtime_access_token_inactive",
      txt(activeRecord?.reason) ?? "Previous Runtime Access Token is not active",
    ),
    status: 401,
  } as const
}

export async function workspaceOpenAuthorizationError(
  services: ControlPlaneServices | undefined,
  auth: SignedControlPlaneAuth,
  result: unknown,
  workspaceId: string,
) {
  const opened = rec(result)
  const openedWorkspace = rec(opened?.workspace)
  const openedWorkspaceId = txt(openedWorkspace?.workspace_id) ?? txt(openedWorkspace?.workspaceId)
  if (opened?.allowed === true && (!openedWorkspaceId || openedWorkspaceId === workspaceId)) return
  await requireAuthority(services).auditDeny(auth, {
    action: "workspaces.open.denied",
    reason: opened?.allowed === true ? "workspace_id_mismatch" : "workspace_authorization_denied",
    workspaceId,
    metadata: openedWorkspaceId ? { openedWorkspaceId } : undefined,
  })
  return {
    error: apiError("workspace_access_denied", "Workspace access denied"),
    status: 403,
  } as const
}

export async function connectionRateLimitError(
  services: ControlPlaneServices | undefined,
  rateLimiter: ConnectionRateLimiter,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
) {
  const rateLimit = rateLimiter.check({
    userId: auth.user.subject,
    workspaceId,
  })
  if (rateLimit.allowed) return
  if (rateLimit.firstRejection ?? true) {
    await requireAuthority(services).auditDeny(auth, {
      action: "runtime_access_token.denied",
      reason: "runtime_access_token_rate_limited",
      workspaceId,
      metadata: {
        retryAfterMs: rateLimit.retryAfterMs,
      },
    })
  }
  return {
    body: {
      error: {
        code: "runtime_access_token_rate_limited",
        message: "Workspace connection token limit exceeded",
        retryAfterMs: rateLimit.retryAfterMs,
      },
    },
    status: 429,
  } as const
}

/**
 * Count of sandbox leases a tenant is currently holding live, or `undefined`
 * when the count could not be taken.
 *
 * Both scopes are optional INDIVIDUALLY but at least one is always supplied —
 * see `sandboxLeaseCapError`, the only thing that builds this input. Passing
 * both is a union, not a sum: `sandboxLeases.countActiveForOrg` counts a lease
 * matching either scope exactly once.
 */
export type ActiveSandboxLeaseCounter = (input: {
  orgId?: string
  ownerSubject?: string
}) => Promise<number | undefined>

/**
 * Per-tenant CONCURRENT sandbox cap for routes that provision real
 * infrastructure.
 *
 * Why this exists alongside `controlPlaneRateLimitError`, rather than instead of
 * it — the two bound different things and neither subsumes the other:
 *
 *  - The rate limiter bounds requests PER MINUTE, and it is a per-isolate
 *    in-memory `Map` (security review §6.7): its ceiling does not hold across
 *    Cloudflare isolates, and it says nothing about how many sandboxes are
 *    already running.
 *  - This cap bounds TOTAL LIVE SANDBOXES, and it is evaluated against durable
 *    Convex state, so it holds no matter how many isolates the flood is spread
 *    across, and it still holds for a slow drip that never trips a rate limit.
 *
 * An unenforceable count (`undefined`) does NOT block the request. That is
 * deliberate and is not a hole an attacker can open: the count comes from the
 * same Convex deployment as the `createCloudWorkspace` write that immediately
 * follows it, so any condition that makes the count unavailable also fails the
 * write. Blocking here would only convert a Convex blip into a create outage.
 *
 * SCOPING. The count is keyed on the ids the LEASE ROWS actually carry, as
 * `sandboxLeases.recordTenant` stamps them:
 *
 *  - `orgId` is the Clerk `org_id` claim (`runtime_leases.org_id`). It is
 *    deliberately NOT `authority.resolveOrgId`, which answers in the
 *    authority's own internal org id space: keying the count on one id space
 *    while the rows carry another produces a count of zero forever, i.e. a cap
 *    that silently never fires. The claim is OPTIONAL — a personal account has
 *    none — which is why the call site must say which org it means and why this
 *    is an input rather than being read off `auth`.
 *  - The owner subject is `auth.user.subject` (`runtime_leases.owner_subject`),
 *    and is read off the verified auth HERE rather than accepted as an input.
 *    Every signed request carries a subject and there is exactly one correct
 *    value for it, so making it a parameter would only create the chance to
 *    omit it — which is precisely the bug this scope exists to fix. Before the
 *    owner column existed, an org-less caller's leases were never attributed,
 *    there was nothing to count, and this guard returned early: the cap could
 *    not bind at all for personal accounts, leaving the rate limiter as their
 *    only bound.
 *
 * A count with NEITHER scope is refused rather than taken: it would return
 * every live lease in the deployment and hand this caller a budget derived from
 * other tenants (`countActiveForOrg` throws for exactly that reason). A signed
 * request always has a subject, so the state is unreachable — the check is a
 * structural assertion, not a path.
 */
export async function sandboxLeaseCapError(
  services: ControlPlaneServices | undefined,
  auth: SignedControlPlaneAuth,
  input: {
    orgId: string | undefined
    cap: number
    action: string
    countActiveLeases: ActiveSandboxLeaseCounter
  },
) {
  if (!(input.cap > 0)) return
  const orgId = input.orgId?.trim()
  const ownerSubject = auth.user.subject?.trim()
  if (!orgId && !ownerSubject) return
  const scope = {
    ...(orgId ? { orgId } : {}),
    ...(ownerSubject ? { ownerSubject } : {}),
  }
  const active = await input.countActiveLeases(scope)
  if (active === undefined || active < input.cap) return
  await requireAuthority(services).auditDeny(auth, {
    action: input.action,
    reason: "sandbox_lease_limit_reached",
    metadata: {
      ...scope,
      activeLeases: active,
      cap: input.cap,
    },
  })
  return {
    body: {
      error: apiError(
        "sandbox_lease_limit_reached",
        orgId
          ? "This organization already holds the maximum number of running cloud workspaces"
          : "You already hold the maximum number of running cloud workspaces",
        {
          activeLeases: active,
          limit: input.cap,
        },
      ),
    },
    status: 429,
  } as const
}

export async function controlPlaneRateLimitError(
  services: ControlPlaneServices | undefined,
  rateLimiter: ConnectionRateLimiter,
  auth: SignedControlPlaneAuth,
  input: {
    key: string
    action: string
    workspaceId?: string
  },
) {
  const rateLimit = rateLimiter.check({
    userId: auth.user.subject,
    workspaceId: input.key,
  })
  if (rateLimit.allowed) return
  if (input.workspaceId && (rateLimit.firstRejection ?? true)) {
    await requireAuthority(services).auditDeny(auth, {
      action: input.action,
      reason: "control_plane_rate_limited",
      workspaceId: input.workspaceId,
      metadata: {
        retryAfterMs: rateLimit.retryAfterMs,
      },
    })
  }
  return {
    body: {
      error: {
        code: "control_plane_rate_limited",
        message: "Control Plane request limit exceeded",
        retryAfterMs: rateLimit.retryAfterMs,
      },
    },
    status: 429,
  } as const
}
