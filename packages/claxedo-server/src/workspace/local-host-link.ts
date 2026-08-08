import type { Context } from "hono"
import { z } from "zod"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { startUserHostedWorkspaceTunnel, stopUserHostedWorkspaceTunnel } from "../user-hosted-tunnel"
import { apiError, captureWorkspaceTelemetry, configuredRelayUrl, hostTunnelCredential, rec, signedOrError, type WorkspaceRouteOptions } from "./route-support"
import { controlPlaneRateLimitError } from "./runtime-token-guards"
import { heartbeatPayload, localHostIdentity, registrationPayload, signHostPayload } from "./local-host"
import { syncWorkspaceAgentExtensionsForSignedUser } from "./signed-access"

const localHostLinkBody = z.object({
  displayName: z.string().optional(),
  ttlMs: z.number().optional(),
}).strict()

const localHostLinkHeartbeatBody = z.object({
  hostId: z.string(),
  ttlMs: z.number().optional(),
}).strict()

const localHostLinkPauseBody = z.object({
  hostId: z.string().optional(),
  paused: z.boolean().default(true),
}).strict()

type LocalHostLinkAuth = {
  auth: SignedControlPlaneAuth
} | {
  error: unknown
  status: number
}

export async function registerLocalHostLink(
  c: Context,
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
) {
  const authResult = await localHostLinkAuth(c.req.raw, options, services)
  if ("error" in authResult) return Response.json(authResult.error, { status: authResult.status })
  const auth = authResult.auth
  const ws = await resolveWorkspace({ workspaceId: c.req.param("id") })
  if (!ws) return c.json({ error: apiError("workspace_not_found", "Workspace not found") }, 404)
  if (ws.kind !== "local") {
    return c.json({
      error: apiError("local_host_link_local_workspace_required", "Only local workspaces can be registered for user-hosted sharing"),
    }, 400)
  }
  const rawBody = await c.req.json().catch(() => ({}))
  if (rec(rawBody)?.hostId) {
    return c.json({
      error: apiError("local_host_link_identity_server_owned", "Local Host Link host identity is server-owned"),
    }, 400)
  }
  const body = localHostLinkBody.parse(rawBody)
  try {
    await requireAuthority(services).usersMe(auth)
    const authority = requireAuthority(services)
    const identity = await localHostIdentity()
    const challenge = await authority.createLocalHostLinkChallenge(auth, {
      workspaceId: ws.id,
      hostId: identity.hostId,
    })
    const link = await authority.registerLocalHostLink(auth, {
      workspaceId: ws.id,
      hostId: identity.hostId,
      publicKey: identity.publicKey,
      challengeId: challenge.challenge_id,
      signature: signHostPayload(identity, registrationPayload({
        workspaceId: ws.id,
        hostId: identity.hostId,
        challengeId: challenge.challenge_id,
        nonce: challenge.nonce,
      })),
      displayName: body.displayName ?? ws.workspace_name ?? ws.project_name ?? ws.repo_name ?? ws.id,
      ttlMs: body.ttlMs,
    })
    const workspace = await authority.registerLocalForSharing(auth, {
      workspaceId: ws.id,
      displayName: ws.workspace_name ?? ws.project_name ?? ws.repo_name ?? ws.id,
      ...(options.defaultHomeRegion ? { homeRegion: options.defaultHomeRegion } : {}),
      projectId: ws.project_id,
      repoUrl: ws.repo_url ?? ws.git_remote,
      repoName: ws.repo_name,
      gitBranch: ws.git_branch,
    })
    await authority.auditAllow(auth, {
      action: "local_host_link.enabled",
      workspaceId: ws.id,
      metadata: {
        hostId: identity.hostId,
      },
    })
    captureWorkspaceTelemetry({
      services,
      auth,
      event: "local_host_link.enabled",
      workspaceId: ws.id,
      properties: {
        hostId: identity.hostId,
      },
    })
    const hostTunnel = await hostTunnelCredential(options, auth, {
      hostId: identity.hostId,
      workspaceId: ws.id,
    })
    const relayUrl = configuredRelayUrl(options)
    if (hostTunnel && relayUrl) {
      await startUserHostedWorkspaceTunnel({
        workspaceId: ws.id,
        hostId: identity.hostId,
        relayUrl,
        hostTunnelToken: hostTunnel.hostTunnelToken,
      })
      await syncWorkspaceAgentExtensionsForSignedUser(services, auth, ws.id).catch(() => {})
    }
    return c.json({
      workspace,
      localHostLink: link,
      hostTunnel,
    })
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
    throw err
  }
}

export async function heartbeatLocalHostLink(
  c: Context,
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  controlPlaneRateLimiter: ConnectionRateLimiter,
) {
  const authResult = await localHostLinkAuth(c.req.raw, options, services)
  if ("error" in authResult) return Response.json(authResult.error, { status: authResult.status })
  const auth = authResult.auth
  const body = localHostLinkHeartbeatBody.parse(await c.req.json().catch(() => ({})))
  try {
    const workspaceId = c.req.param("id")
    const authority = requireAuthority(services)
    await authority.usersMe(auth)
    const rateLimit = await controlPlaneRateLimitError(services, controlPlaneRateLimiter, auth, {
      key: `hostPresence.refresh:${workspaceId}:${body.hostId}`,
      action: "hostPresence.refresh.denied",
      workspaceId,
    })
    if (rateLimit) return c.json(rateLimit.body, rateLimit.status)
    const identity = await localHostIdentity()
    const link = await authority.heartbeatLocalHostLink(auth, {
      workspaceId,
      hostId: body.hostId,
      signature: signHostPayload(identity, heartbeatPayload({
        workspaceId,
        hostId: body.hostId,
        ttlMs: body.ttlMs,
      })),
      ttlMs: body.ttlMs,
    })
    const hostTunnel = await hostTunnelCredential(options, auth, {
      hostId: body.hostId,
      workspaceId,
    })
    const relayUrl = configuredRelayUrl(options)
    if (hostTunnel && relayUrl) {
      await startUserHostedWorkspaceTunnel({
        workspaceId,
        hostId: body.hostId,
        relayUrl,
        hostTunnelToken: hostTunnel.hostTunnelToken,
      })
      await syncWorkspaceAgentExtensionsForSignedUser(services, auth, workspaceId).catch(() => {})
    }
    if (hostTunnel) return c.json({ localHostLink: link, hostTunnel })
    return c.json(link)
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
    throw err
  }
}

export async function pauseLocalHostLink(
  c: Context,
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
) {
  const authResult = await localHostLinkAuth(c.req.raw, options, services)
  if ("error" in authResult) return Response.json(authResult.error, { status: authResult.status })
  const auth = authResult.auth
  const body = localHostLinkPauseBody.parse(await c.req.json().catch(() => ({})))
  try {
    await requireAuthority(services).usersMe(auth)
    const result = await requireAuthority(services).pauseLocalHostLink(auth, {
      workspaceId: c.req.param("id"),
      hostId: body.hostId,
      paused: body.paused,
    })
    if (body.paused) {
      if (body.hostId) {
        stopUserHostedWorkspaceTunnel({
          workspaceId: c.req.param("id"),
          hostId: body.hostId,
        })
      }
      await requireAuthority(services).auditAllow(auth, {
        action: "local_host_link.disabled",
        workspaceId: c.req.param("id"),
        metadata: {
          hostId: body.hostId,
        },
      })
      captureWorkspaceTelemetry({
        services,
        auth,
        event: "local_host_link.disabled",
        workspaceId: c.req.param("id"),
        properties: {
          hostId: body.hostId,
        },
      })
    }
    return c.json(result)
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
    throw err
  }
}

async function localHostLinkAuth(
  request: Request,
  options: WorkspaceRouteOptions,
  services: ControlPlaneServices | undefined,
): Promise<LocalHostLinkAuth> {
  const authResult = await signedOrError(request, {
    ...options,
    requireSigned: true,
  }, services)
  if (authResult.auth) return { auth: authResult.auth }
  if (authResult.error) return { error: authResult.error, status: authResult.status ?? 401 }
  return {
    error: controlPlaneAuthErrorBody(
      new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required"),
    ),
    status: 401,
  } as const
}
