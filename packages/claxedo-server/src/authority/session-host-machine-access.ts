import type { RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { ControlPlaneServices } from "./services"
import type { SessionHostAuthority } from "./session-hosts"
import { resolveWorkspaceRuntimeTarget } from "./runtime-target"

export type SessionHostMachineDeps = {
  services: ControlPlaneServices
  sessionHosts: SessionHostAuthority
  relayEndpoint(workspaceId: string, homeRegion: ClaxedoRegion): string | Promise<string>
  signRuntimeAccessToken: RuntimeAccessTokenSigner
}

export type SessionHostMachineAccess = {
  relayUrl: string
  hostId: string
  routingId?: string
  runtimeAccessToken: string
  expiresAt: number
}

/**
 * An editor token for the workspace machine on behalf of a session served by
 * its own host, recorded before it is handed out. `turn` is the session's own
 * token for its tools, reaching that session alone; `session-mcp` is the
 * workspace owner's, which the first-party MCP endpoint reaches the machine
 * with for that session's tools. A machine still starting throws the target's
 * 409 for the caller to answer.
 */
export async function sessionHostMachineAccess(deps: SessionHostMachineDeps, input: {
  scope: "turn" | "session-mcp"
  actorId: string
  orgId: string
  workspaceId: string
  sessionId: string
  ttlSeconds: number
}): Promise<SessionHostMachineAccess> {
  const { actorId, workspaceId, sessionId } = input
  const target = await resolveWorkspaceRuntimeTarget(deps.services, undefined, { workspaceId, workspace: { backing: "cloud-vm" } })
  const token = await deps.signRuntimeAccessToken({
    principalKind: "user",
    actorId,
    actorKind: "human",
    orgId: input.orgId,
    workspaceId,
    hostId: target.hostId,
    ...(target.routingId ? { routingId: target.routingId } : {}),
    role: "editor",
    ...(input.scope === "turn" ? { sessionId, purpose: "turn-execution" as const } : {}),
    ttlSeconds: input.ttlSeconds,
  })
  const record = { jti: token.jti, workspaceId, hostId: target.hostId, sessionId, expiresAt: token.tokenExpiresAt }
  if (input.scope === "turn") await deps.sessionHosts.recordTurnRuntimeAccessToken(actorId, record)
  else await deps.sessionHosts.recordSessionMcpRuntimeAccessToken(actorId, record)
  const relayUrl = await deps.relayEndpoint(workspaceId, target.homeRegion)
  return {
    relayUrl: relayUrl.replace(/\/+$/, ""),
    hostId: target.hostId,
    ...(target.routingId ? { routingId: target.routingId } : {}),
    runtimeAccessToken: token.runtimeAccessToken,
    expiresAt: token.tokenExpiresAt,
  }
}
