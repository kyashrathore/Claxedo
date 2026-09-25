import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import type { ControlPlaneServices } from "../authority/services"

export function hostedRuntimeFetch(
  services: ControlPlaneServices,
  workspaceId: string,
  identity: { orgId: string; projectId: string },
  requestPath: string,
  init: RequestInit,
) {
  const workspace: Workspace = {
    id: workspaceId,
    org_id: identity.orgId,
    project_id: identity.projectId,
    directory: "/workspace",
    kind: "cloud",
    created_at: 0,
    updated_at: 0,
  }
  return sandboxFetch(workspace, requestPath, init, {
    ...(services.sandbox.sandboxManager ? { sandboxManager: services.sandbox.sandboxManager } : {}),
    ...(services.relay.provider ? { relayProvider: services.relay.provider } : {}),
    ...(services.defaultHomeRegion ? { defaultHomeRegion: services.defaultHomeRegion } : {}),
    orgId: identity.orgId,
    runtimeActor: { principalKind: "service", actorId: "control-plane", actorKind: "agent" },
    role: "owner",
    resume: false,
  })
}
