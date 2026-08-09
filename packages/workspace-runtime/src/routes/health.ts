import type { AgentHarnessAdapterHealth } from "@claxedo/agent-sdk-runtime/adapters"
import type { WorkspaceRuntimeRouteAuthBoundary, WorkspaceRuntimeServiceExposure } from "../server"

export type WorkspaceRuntimeLivenessInput = {
  state: string
  harness: {
    id: string
    connection?: {
      kind: string
      binary?: string
    }
  }
  error?: string | null
  harnessHealth: AgentHarnessAdapterHealth
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
    agentType: input.harness.id,
    acpBinary: input.harness.id === "opencode"
      ? null
      : input.harness.connection?.kind === "process"
        ? input.harness.connection.binary ?? null
        : null,
    error: input.error || null,
    harnessHealth: input.harnessHealth,
  }
}

export type WorkspaceRuntimeLivenessResponse = ReturnType<typeof workspaceRuntimeLivenessResponse>
