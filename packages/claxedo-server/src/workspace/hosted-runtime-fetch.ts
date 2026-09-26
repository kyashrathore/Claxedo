import { mintSupervisorBackplaneToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { CONTROL_PLANE_RUNTIME_ACTOR } from "@claxedo/server-core/platform/auth/runtime-actor"
import { createWorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import type { RuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import type { ControlPlaneServices } from "../authority/services"

async function readyTarget(services: ControlPlaneServices, workspaceId: string) {
  const manager = services.sandbox.sandboxManager
  if (!manager) throw new Error("hosted sandbox manager is unavailable")
  const target = await manager.target(workspaceId)
  if (target.status !== "ready") throw new Error(`hosted sandbox ${workspaceId} is unavailable`)
  return target
}

export async function hostedRuntimeFetch(
  services: ControlPlaneServices,
  workspaceId: string,
  identity: { orgId: string; projectId: string },
  requestPath: string,
  init: RequestInit,
) {
  const target = await readyTarget(services, workspaceId)
  const relay = services.relay.provider
  if (!relay) throw new Error("hosted runtime token issuer is unavailable")
  const token = await relay.mintRuntimeAccessToken({
    workspaceId,
    hostId: target.hostId,
    orgId: identity.orgId,
    ...CONTROL_PLANE_RUNTIME_ACTOR,
    role: "owner",
    ttlMs: 10 * 60_000,
  })
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token.token}`)
  return fetch(`${target.url.replace(/\/+$/, "")}${requestPath}`, { ...init, headers })
}

export async function hostedRuntimeConfigApply(
  services: ControlPlaneServices,
  workspaceId: string,
  snapshot: RuntimeSnapshot,
  signingEnv: Record<string, string | undefined>,
) {
  const target = await readyTarget(services, workspaceId)
  const token = await mintSupervisorBackplaneToken({
    workspaceId,
    hostId: target.hostId,
    subject: "workspace-supervisor",
  }, signingEnv)
  await createWorkspaceRuntimeClient({ baseUrl: target.url }).applyConfig(snapshot, { token: token.supervisorBackplaneToken })
}
