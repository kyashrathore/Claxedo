import type { Hono } from "hono"
import type { PtyRoutes } from "../routes/pty"
import type { RuntimeRunner, RuntimeSnapshot } from "../routes/config"
import type { WorkspaceCapabilities } from "../capabilities"
import type { WorkspaceProfile } from "../profile"
import type { AgentHarnessAdapterHealth } from "@claxedo/agent-sdk-runtime/adapters"
import type { WorkspaceRuntimeExposure } from "../exposure"

export type RuntimeConfigApplyStatus = {
  state: "idle" | "applying" | "applied" | "failed"
  revision: number
  acceptedAt?: string
  updatedAt?: string
  harness?: RuntimeRunner
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export type WorkspaceHostMountOptions = {
  exposure: WorkspaceRuntimeExposure
  /** When provided, also mounts the workspace core routes (file, diff,
   *  PTY, process, tunnel, agent hooks, events, capabilities) as a
   *  single unified host. Without this, only the session/runner
   *  surfaces are mounted and callers must mount the core separately. */
  core?: {
    upgradeWebSocket: Parameters<typeof PtyRoutes>[0]
    profile?: WorkspaceProfile
  }
  pty?: {
    upgradeWebSocket: Parameters<typeof PtyRoutes>[0]
  }
  process?: boolean
  agentHooks?: boolean
}

export type WorkspaceCheckpointState = "active" | "freezing" | "frozen"
export type WorkspaceCheckpointDrainPolicy = "drain" | "interrupt"

export type WorkspaceCheckpointControl = {
  detail: () => {
    state: WorkspaceCheckpointState
    activeWrites: number
    activeTurns: number
    reconciledEpoch?: number
  }
  beginWrite: () => (() => void) | undefined
  freeze: (policy: WorkspaceCheckpointDrainPolicy) => Promise<ReturnType<WorkspaceCheckpointControl["detail"]>>
  flush: () => Promise<void>
  scrub: () => Promise<void>
  resume: () => Promise<ReturnType<WorkspaceCheckpointControl["detail"]>>
  restoreReconcile: (input: { epoch: number; checkpointId: string }) => Promise<ReturnType<WorkspaceCheckpointControl["detail"]>>
}

export type WorkspaceHost = {
  mount: (app: Hono, options: WorkspaceHostMountOptions) => void
  apply: (snapshot: RuntimeSnapshot) => Promise<void>
  detail: () => {
    state: "ready" | "applying" | "error"
    healthStatus: "ok" | "degraded" | "unavailable"
    harness: RuntimeRunner
    error: string
    harnessHealth: AgentHarnessAdapterHealth
    workspaceHarnessEnabled: boolean
    configApply: RuntimeConfigApplyStatus
  }
  capabilities: () => WorkspaceCapabilities
  registerSessionTools: (input: {
    sessionId: string
    harness?: string
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; callbackUrl?: string }>
  }) => Promise<void>
  unregisterSessionTools: (sessionId: string) => Promise<void>
  checkpoint: WorkspaceCheckpointControl
  dispose: () => void
}
