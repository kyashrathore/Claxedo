import {
  workspaceRuntimeLivenessResponse,
  type WorkspaceRuntimeLivenessResponse,
} from "../../../../workspace-runtime/src/routes/health"

export function readyRuntimeHealthResponse(agentType: string): WorkspaceRuntimeLivenessResponse {
  return workspaceRuntimeLivenessResponse({
    state: "ready",
    harness: { id: agentType },
    harnessHealth: { status: "ok" },
    routeAuthBoundary: "relay-host-auth",
    serviceExposure: {
      source: "driver-service-url",
      access: "driver-authenticated",
    },
    exposure: { kind: "relay" },
  })
}
