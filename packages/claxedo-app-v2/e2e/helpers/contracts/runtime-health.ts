import {
  workspaceRuntimeLivenessResponse,
  type WorkspaceRuntimeLivenessResponse,
} from "../../../../workspace-runtime/src/routes/health"

export function readyRuntimeHealthResponse(agentType: string): WorkspaceRuntimeLivenessResponse {
  return workspaceRuntimeLivenessResponse({
    state: "ready",
    harness: { kind: "native", harnessId: agentType as "claude" | "codex" | "cursor" | "pi" },
    harnessHealth: { status: "ok" },
    routeAuthBoundary: "relay-host-auth",
    serviceExposure: {
      source: "driver-service-url",
      access: "driver-authenticated",
    },
    exposure: { kind: "relay" },
    workspaceId: "ws_e2e",
    ptyCount: 0,
    processCount: 0,
    activeProcessCount: 0,
  })
}
