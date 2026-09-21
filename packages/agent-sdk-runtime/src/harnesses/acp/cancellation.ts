import type { RecoveryErrorCode } from "@claxedo/agent-runtime-contract"
import type { AdapterCancelOutcome } from "../../adapter-contract"
import { stoppedWaiting } from "../shared/sdk-runtime-cancellation"
import type { ACPProcess } from "./process"
import { cancelPendingPermissions, type PermissionReplyPort } from "./permission-reply"

export type AcpCancelPorts = {
  sessionId: string
  agentSessionId: string | null | undefined
  /** The process serving this session, or nothing when none is alive. */
  proc: ACPProcess | undefined
  permissions: PermissionReplyPort
  /** Resolves once this session has no turn running, however it ended. */
  whenIdle(sessionId: string): Promise<void>
  hasActiveTurn(sessionId: string): boolean
  markInterrupted(message: string, agentSessionId?: string): void
  log(event: string, details: Record<string, unknown>): void
}

/**
 * What stopping an ACP turn establishes.
 *
 * ACP's cancel is a notification: the agent acknowledging it means the message
 * arrived, not that the prompt ended. The prompt promise settling is the only
 * thing this owner witnesses, and even that is evidence about the agent only
 * when the agent is a child of this process — over http or a websocket what
 * settles is this end of the wire.
 *
 * Cleanup is always unknown: the agent runs its tools itself and publishes no
 * inventory of what a turn started.
 */
export async function cancelAcpTurn(
  ports: AcpCancelPorts,
  input: { turnId: string; signal: AbortSignal; deadlineAt: number },
): Promise<AdapterCancelOutcome> {
  const { sessionId, agentSessionId, proc } = ports
  const cleanup = "unknown" as const
  const unresolved = (code: RecoveryErrorCode, message: string): AdapterCancelOutcome =>
    ({ execution: "unknown", cleanup, error: { code, message } })

  if (!agentSessionId) {
    ports.log("cancelTurn: session not found in store", { id: sessionId })
    const message = "ACP session could not be cancelled because no agent session is attached."
    ports.markInterrupted(message)
    return unresolved("ownership_unverified", message)
  }
  if (!proc?.alive) {
    ports.log("cancelTurn: no alive process for session", { id: sessionId })
    const message = "ACP session could not be cancelled because its process is no longer alive."
    ports.markInterrupted(message, agentSessionId)
    return unresolved("provider_unreachable", message)
  }

  try {
    cancelPendingPermissions(ports.permissions, proc, sessionId, agentSessionId)
    await proc.cancelAndWait(agentSessionId)
  } catch (err) {
    ports.log("cancelTurn: cancellation outcome uncertain", { id: sessionId, err })
    const message = "ACP session cancellation was not acknowledged; its outcome is uncertain."
    // A live original turn owns its recovering status and eventual terminal
    // event. Do not queue a restart error for its next successful prompt.
    if (!ports.hasActiveTurn(sessionId)) ports.markInterrupted(message, agentSessionId)
    return unresolved("provider_unreachable", message)
  }

  const settled = await Promise.race([
    ports.whenIdle(sessionId).then(() => true, () => true),
    stoppedWaiting(input),
  ])
  if (!settled) return {
    execution: "running",
    cleanup,
    error: {
      code: "cancellation_timeout",
      message: `ACP session ${sessionId} acknowledged the cancel but its prompt had not settled when the deadline passed.`,
    },
  }
  if (proc.transportKind !== "stdio") return unresolved(
    "provider_unreachable",
    `ACP session ${sessionId} is served over ${proc.transportKind}; a settled prompt here does not establish that the remote agent stopped.`,
  )
  return { execution: "terminal", cleanup }
}
