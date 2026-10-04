import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { apiError, txt } from "./route-support"
import { asRecord } from "@claxedo/server-core/platform/json/index"

export async function runtimeTokenOrgId(
  authority: WorkspaceAuthority,
  auth: SignedControlPlaneAuth,
  workspace: unknown,
) {
  const row = asRecord(workspace)
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
  if (!input.previousJti) return undefined
  const authority = requireAuthority(services)
  const active = await authority.runtimeAccessTokenActive({
    jti: input.previousJti,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
  })
  const activeRecord = asRecord(active)
  if (activeRecord?.active === true) return undefined
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
  const opened = asRecord(result)
  const openedWorkspace = asRecord(opened?.workspace)
  const openedWorkspaceId = txt(openedWorkspace?.workspace_id) ?? txt(openedWorkspace?.workspaceId)
  if (opened?.allowed === true && (!openedWorkspaceId || openedWorkspaceId === workspaceId)) return undefined
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
  if (rateLimit.allowed) return undefined
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
 * Who a sandbox lease is counted against: the tenant the cap binds. `orgId`
 * and `ownerSubject` are the columns a lease's tenant stamp carries; a caller
 * with a signed request reads them off it, a caller resolved from a minted
 * credential names the owner's.
 */
export type SandboxLeaseTenant = {
  orgId?: string
  ownerSubject?: string
}

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
 *    central state, so it holds no matter how many isolates the flood is spread
 *    across, and it still holds for a slow drip that never trips a rate limit.
 *
 * An unenforceable count (`undefined`) does NOT block the request. That is
 * deliberate and is not a hole an attacker can open: the count comes from the
 * same deployment as the `createCloudWorkspace` write that immediately
 * follows it, so any condition that makes the count unavailable also fails the
 * write. Blocking here would only convert a store blip into a create outage.
 *
 * SCOPING. The count is keyed on the ids the LEASE ROWS actually carry, as
 * `sandboxLeases.recordTenant` stamps them:
 *
 *  - `orgId` is the `org_id` claim (`runtime_leases.org_id`). It is
 *    deliberately NOT `authority.resolveOrgId`, which answers in the
 *    authority's own internal org id space: keying the count on one id space
 *    while the rows carry another produces a count of zero forever, i.e. a cap
 *    that silently never fires. The claim is OPTIONAL — a personal account has
 *    none — which is why the call site must say which org it means and why this
 *    is an input rather than being read off `auth`.
 *  - The owner subject is `auth.user.subject` (`runtime_leases.owner_subject`),
 *    and is read off the verified auth HERE rather than accepted as an input.
 *    Every signed request carries a subject and there is exactly one correct
 *    value for it — the bug this scope exists to fix is a call site omitting
 *    it, which is why the signed door takes `auth` and derives it. A caller
 *    resolved from a minted credential holds no request to read one off, so
 *    `sandboxLeaseCapDenial` takes the tenant explicitly for it. Before the
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
  return await sandboxLeaseCapDenial(services, {
    tenant: { orgId: input.orgId, ownerSubject: auth.user.subject },
    audit: auth,
    cap: input.cap,
    action: input.action,
    countActiveLeases: input.countActiveLeases,
  })
}

/**
 * The cap `sandboxLeaseCapError` enforces, for a caller that names its tenant
 * directly rather than through a signed request — a minted credential's
 * resolved owner. `audit` is the denial's signed context when one exists;
 * `auditDeny` accepts its absence.
 */
export async function sandboxLeaseCapDenial(
  services: ControlPlaneServices | undefined,
  input: {
    tenant: SandboxLeaseTenant
    audit?: SignedControlPlaneAuth
    cap: number
    action: string
    countActiveLeases: ActiveSandboxLeaseCounter
  },
) {
  if (!(input.cap > 0)) return undefined
  const orgId = input.tenant.orgId?.trim()
  const ownerSubject = input.tenant.ownerSubject?.trim()
  if (!orgId && !ownerSubject) return undefined
  const scope = {
    ...(orgId ? { orgId } : {}),
    ...(ownerSubject ? { ownerSubject } : {}),
  }
  const active = await input.countActiveLeases(scope)
  if (active === undefined || active < input.cap) return undefined
  await requireAuthority(services).auditDeny(input.audit, {
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
  return await controlPlaneRateLimitDenial(services, rateLimiter, {
    subject: auth.user.subject,
    audit: auth,
  }, input)
}

/**
 * `controlPlaneRateLimitError` for a caller that names its account directly —
 * a minted credential's resolved owner — instead of through a signed request.
 * `subject` is the bucket key; `audit` is the denial's signed context when one
 * exists.
 */
export async function controlPlaneRateLimitDenial(
  services: ControlPlaneServices | undefined,
  rateLimiter: ConnectionRateLimiter,
  caller: {
    subject?: string
    audit?: SignedControlPlaneAuth
  },
  input: {
    key: string
    action: string
    workspaceId?: string
  },
) {
  const rateLimit = rateLimiter.check({
    userId: caller.subject ?? "",
    workspaceId: input.key,
  })
  if (rateLimit.allowed) return undefined
  if (input.workspaceId && (rateLimit.firstRejection ?? true)) {
    await requireAuthority(services).auditDeny(caller.audit, {
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
