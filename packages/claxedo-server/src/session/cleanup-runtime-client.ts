import { createWorkspaceRuntimeClient, type WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { requireAuthority, type RuntimeActorIdentity } from "@claxedo/server-core/platform/auth/authority"
import { normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { createRelayRuntimeClient } from "../workspace/relay-runtime-client"
import type { ControlPlaneServices } from "../authority/services"

export type SessionCleanupIdentity = {
  userId: string
  actorId: string
  orgId: string
  auth?: SignedControlPlaneAuth
}

export async function sessionCleanupRuntimeClient(services: ControlPlaneServices, identity: SessionCleanupIdentity, workspaceId: string, authorizeDispatch?: () => Promise<void>): Promise<WorkspaceRuntimeClient> {
  const request = await sessionCleanupRuntimeRequest(services, identity, workspaceId, authorizeDispatch)
  return createWorkspaceRuntimeClient({ baseUrl: "http://session-cleanup.runtime", workspace: workspaceId, fetch: (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    return request(`${url.pathname}${url.search}`, init)
  } })
}

export async function sessionCleanupRuntimeRequest(services: ControlPlaneServices, identity: SessionCleanupIdentity, workspaceId: string, authorizeDispatch?: () => Promise<void>) {
  const authority = requireAuthority(services)
  const principal = { principalKind: "user", actorKind: "human", actorId: identity.actorId } as const
  const opened = identity.auth
    ? await authority.openWorkspace(identity.auth, { workspaceId })
    : await authority.openRuntimeWorkspace?.(principal, { workspaceId })
  const workspace = opened?.workspace
  if (!workspace || opened?.allowed === false || opened?.role !== "owner" || workspace.org_id !== identity.orgId) {
    throw unavailable(403, "session_cleanup_access_denied", "Workspace cleanup access was denied")
  }
  const provider = services.relay.provider
  if (!provider) throw unavailable(503, "workspace_relay_unavailable", "Workspace relay is unavailable")
  const target = workspace.backing === "local-worktree"
    ? await services.relay.hostTunnelResolver?.(workspaceId).then((host) => host.active ? { hostId: host.hostId } : undefined)
    : await services.sandbox.sandboxManager?.target(workspaceId).then((target) => target.status === "ready" ? target : undefined)
  if (!target) throw unavailable(503, "workspace_runtime_unavailable", "The workspace runtime is offline or stopped")
  const relay = createRelayRuntimeClient({ provider, error: unavailable, ...(authorizeDispatch ? { request: async (request: RequestInfo | URL, init?: RequestInit) => {
    // Relay token minting and endpoint lookup await external services. Recheck after
    // both, immediately before sending; a refusal here has not dispatched a delete.
    try { await authorizeDispatch() } catch (error) {
      if (!(error instanceof ClaxedoError)) throw error
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
    }
    return globalThis.fetch(request, init)
  } } : {}) })
  const actor: RuntimeActorIdentity = { userId: identity.userId, actorId: identity.actorId, actorKind: "human" }
  return (path: string, init?: RequestInit) => relay.fetch({ ...principal, ...actor, workspaceId, orgId: identity.orgId, hostId: target.hostId, role: "owner", ttlMs: 60_000, homeRegion: normalizeClaxedoRegion(workspace.home_region, services.defaultHomeRegion) }, path, { ...init, redirect: "manual" })
}

function unavailable(status: number, code: string, message: string) {
  return new ClaxedoError({ status, code, message })
}
