import type { SignedControlPlaneAuth } from "../control-plane/auth"
import type { ConnectionRateLimiter } from "../control-plane/rate-limit"
import type { ControlPlaneServices } from "../control-plane/services"
import { requireAuthority, type WorkspaceAuthority } from "../control-plane/authority"
import { apiError, rec, txt } from "./workspace-route-support"

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
