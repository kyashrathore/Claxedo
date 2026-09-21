import type { AgentHarnessAdapterHealth } from "@claxedo/agent-sdk-runtime/adapters"
import type { WorkspaceRuntimeRouteAuthBoundary, WorkspaceRuntimeServiceExposure } from "../server"
import type { WorkspaceConnectionState } from "../workspace/host"

export type WorkspaceRuntimeLivenessInput = {
  state: string
  harness?:
    | { kind: "native"; harnessId: string }
    | { kind: "connection"; connectionId: string }
  error?: string | null
  harnessHealth: AgentHarnessAdapterHealth
  connectionState?: WorkspaceConnectionState
  routeAuthBoundary: WorkspaceRuntimeRouteAuthBoundary
  serviceExposure: WorkspaceRuntimeServiceExposure
  exposure?: { kind: string }
}

/** Canonical response producer for `GET /api/wr/health`. */
export function workspaceRuntimeLivenessResponse(input: WorkspaceRuntimeLivenessInput) {
  return {
    ok: input.state !== "error",
    status: input.state,
    service: "workspace-runtime" as const,
    routeAuthBoundary: input.routeAuthBoundary,
    serviceExposure: input.serviceExposure,
    exposure: input.exposure,
    // Harness-health detail is intentionally present on the lightweight probe;
    // diagnostics-only capabilities, directory, and process counts are not.
    ...(input.harness ? { harness: input.harness, activeHarness: input.harness } : {}),
    error: input.error || null,
    harnessHealth: input.harnessHealth,
    ...(input.connectionState ? { connectionState: input.connectionState } : {}),
  }
}

export type WorkspaceRuntimeLivenessResponse = ReturnType<typeof workspaceRuntimeLivenessResponse>
