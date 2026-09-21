import type { Hono } from "hono"
import type { PtyRoutes } from "../routes/pty"
import type { RuntimeHarnessSelection, RuntimeSnapshot } from "../routes/config"
import type { WorkspaceCapabilities } from "../capabilities"
import type { WorkspaceProfile } from "../profile"
import type { AgentHarnessAdapterHealth } from "@claxedo/agent-sdk-runtime/adapters"
import type { WorkspaceRuntimeExposure } from "../exposure"
import type { WorkspaceEventFramesTap } from "../routes/events"
import type { SessionConfig } from "@claxedo/agent-sdk-runtime"
import type { RuntimeCredentialIssuer } from "../first-party-mcp/credential"
import type { FirstPartyMcpServerEntry } from "../first-party-mcp/index"
import type { ConnectionRuntimeStatus } from "@claxedo/agent-runtime-contract"

export type WorkspaceConnectionState = ConnectionRuntimeStatus & { connectionId: string }

export type RuntimeConfigApplyStatus = {
  state: "idle" | "applying" | "applied" | "failed"
  revision: number
  acceptedAt?: string
  updatedAt?: string
  harness?: RuntimeHarnessSelection
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export type WorkspaceHostMountOptions = {
  /** The stream's renewal cadence; a test shortens it to watch a lease lapse. */
  renewalIntervalMs?: number
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

export type WorkspaceCheckpointDetail = {
  state: WorkspaceCheckpointState
  activeWrites: number
  activeTurns: number
  reconciledEpoch?: number
}

/**
 * One writer a freeze could not account for. `sessionId` is absent only for a
 * checkpoint write, which belongs to no session; `detail` carries how many.
 */
export type WorkspaceCheckpointBlocker = {
  sessionId?: string
  turnId?: string
  reason: string
  error?: string
}

/**
 * A freeze either fenced everything it could see, or names what it could not.
 * There is no third answer: reporting frozen over a writer nobody accounted
 * for is what let a checkpoint be taken beside a live producer.
 */
export type WorkspaceCheckpointFreezeResult =
  | { state: "frozen"; detail: WorkspaceCheckpointDetail }
  | { state: "blocked"; blockers: WorkspaceCheckpointBlocker[]; detail: WorkspaceCheckpointDetail }

export type WorkspaceCheckpointControl = {
  detail: () => WorkspaceCheckpointDetail
  beginWrite: () => (() => void) | undefined
  freeze: (
    policy: WorkspaceCheckpointDrainPolicy,
    options?: { deadlineAt?: number },
  ) => Promise<WorkspaceCheckpointFreezeResult>
  flush: () => Promise<void>
  scrub: () => Promise<void>
  resume: () => Promise<ReturnType<WorkspaceCheckpointControl["detail"]>>
  restoreReconcile: (input: { epoch: number; checkpointId: string }) => Promise<ReturnType<WorkspaceCheckpointControl["detail"]>>
}

export type WorkspaceHost = {
  mount: (app: Hono, options: WorkspaceHostMountOptions) => void
  hasSession: (sessionId: string) => boolean
  /**
   * Every frame this host's `wr/events` serves, verbatim, for a process
   * hosting several runtimes behind one stream. One object for the host's
   * lifetime, so a consumer may subscribe across `mount`; it is fed by the
   * mounted stream's own subscriptions and carries nothing until one exists.
   */
  frames: WorkspaceEventFramesTap
  /** In-process consumers read the same committed configuration as the session API. */
  getSessionConfig: (sessionId: string) => SessionConfig | undefined
  parentSessionIdFor: (sessionId: string) => string | undefined
  /**
   * The issuer behind the bearer this runtime injects into its sessions, for
   * the host that mounts `/api/claxedo/mcp` to verify callers with. Absent when
   * the runtime was composed without `firstPartyMcpLaunch`.
   */
  runtimeCredentialIssuer: () => RuntimeCredentialIssuer | undefined
  /** The `claxedo` MCP entry this runtime injects into a session's harness config, absent for the same reason. */
  firstPartyMcpServer: (sessionId: string) => FirstPartyMcpServerEntry | undefined
  apply: (snapshot: RuntimeSnapshot) => Promise<void>
  /** Replace only host-composed launch metadata while preserving the accepted runtime configuration. */
  applyHarnessLaunch: (harnessLaunch: Record<string, Record<string, unknown>>) => Promise<void>
  detail: () => {
    state: "ready" | "applying" | "error"
    healthStatus: "ok" | "degraded" | "unavailable"
    harness?: RuntimeHarnessSelection
    error: string
    harnessHealth: AgentHarnessAdapterHealth
    connectionState?: WorkspaceConnectionState
    workspaceHarnessEnabled: boolean
    configApply: RuntimeConfigApplyStatus
  }
  /** Read health for one session's resolved harness, without unrelated session history. */
  readHarnessHealth: (input: { sessionId: string; directory?: string }) => Promise<AgentHarnessAdapterHealth>
  readConnectionState: (input?: { sessionId?: string; directory?: string }) => WorkspaceConnectionState | undefined
  capabilities: () => WorkspaceCapabilities
  /** Canonical in-process work that prevents daemon quiescence. */
  activity: () => {
    activeTurns: number
    activeWrites: number
    checkpointState: WorkspaceCheckpointState
  }
  registerSessionTools: (input: {
    sessionId: string
    harness?: string
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; callbackUrl?: string }>
  }) => Promise<void>
  unregisterSessionTools: (sessionId: string) => Promise<void>
  checkpoint: WorkspaceCheckpointControl
  dispose: () => Promise<void>
}
