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
  workspaceId: string
  /** Runtime-wide load counters the supervisor's idle check reads through the config-token grant. */
  ptyCount: number
  processCount: number
  activeProcessCount: number
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
    workspaceId: input.workspaceId,
    // Harness-health detail is intentionally present on the lightweight probe;
    // diagnostics-only capabilities and directory are not.
    ...(input.harness ? { harness: input.harness, activeHarness: input.harness } : {}),
    error: input.error || null,
    harnessHealth: input.harnessHealth,
    ...(input.connectionState ? { connectionState: input.connectionState } : {}),
    ptyCount: input.ptyCount,
    processCount: input.processCount,
    activeProcessCount: input.activeProcessCount,
  }
}

export type WorkspaceRuntimeLivenessResponse = ReturnType<typeof workspaceRuntimeLivenessResponse>

export type WorkspaceRuntimeProbeInput = {
  ok: boolean
  status: string
  /**
   * The workspace this runtime answers for. `WORKSPACE_RUNTIME_IDENTITY_PATH`
   * names this route: the control plane's verify-then-read flow requires the
   * probe to echo the workspace it asked about.
   */
  workspaceId: string
  /** The lease generation a report about this runtime has to be fenced with; absent when no control plane placed it. */
  epoch?: number
}

/**
 * Canonical response producer for `GET /global/health` — the deliberately
 * pre-auth liveness/identity mount. Anonymous callers get liveness, identity
 * and the lease epoch only; runtime diagnostics live behind the authenticated
 * `/api/wr/health`.
 */
export function workspaceRuntimeProbeResponse(input: WorkspaceRuntimeProbeInput) {
  return {
    healthy: input.ok,
    ok: input.ok,
    status: input.status,
    service: "workspace-runtime" as const,
    workspaceId: input.workspaceId,
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
  }
}

export type WorkspaceRuntimeProbeResponse = ReturnType<typeof workspaceRuntimeProbeResponse>
