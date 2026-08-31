import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION, type AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import { eventDirectoryForLiveSession } from "./live-session"
import type { LiveSession } from "../global-sdk-event-fetch"

type EventDirectory = string

export type RuntimeEventEnvelope = {
  contractVersion: typeof AGENT_RUNTIME_EVENT_CONTRACT_VERSION
  directory: EventDirectory
  sessionId: string
  agentSessionId?: string
  assistantMessageId?: string
  payload: AgentRuntimeEvent
}

export function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

export function runtimeEnvelope(input: unknown): RuntimeEventEnvelope | undefined {
  const row = record(input)
  const payload = record(row?.payload)
  if (row?.contractVersion !== AGENT_RUNTIME_EVENT_CONTRACT_VERSION) return
  if (typeof row?.directory !== "string") return
  if (typeof row.sessionId !== "string") return
  if (typeof payload?.type !== "string") return
  return {
    contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
    directory: row.directory,
    sessionId: row.sessionId,
    ...(typeof row.agentSessionId === "string" ? { agentSessionId: row.agentSessionId } : {}),
    ...(typeof row.assistantMessageId === "string" ? { assistantMessageId: row.assistantMessageId } : {}),
    payload: payload as AgentRuntimeEvent,
  }
}

/**
 * A runtime frame this app cannot decode because the runtime speaks a different
 * event contract.
 *
 * `runtimeEnvelope` DROPS those frames — there is no previous-contract
 * compatibility path, and inventing one would silently mis-project events.
 * Dropping them SILENTLY is the real problem: the session stops updating and
 * just looks frozen. This detects the case so the provider can say so.
 */
export function runtimeContractMismatch(input: unknown): { contractVersion: unknown } | undefined {
  const row = record(input)
  if (!row || row.contractVersion === undefined) return
  if (row.contractVersion === AGENT_RUNTIME_EVENT_CONTRACT_VERSION) return
  if (typeof row.directory !== "string" || typeof row.sessionId !== "string") return
  if (typeof record(row.payload)?.type !== "string") return
  return { contractVersion: row.contractVersion }
}

export function runtimeContractMismatchMessage(contractVersion: unknown) {
  return `This workspace runtime is running an incompatible version: it emits agent event contract v${String(contractVersion)}, but this app requires v${AGENT_RUNTIME_EVENT_CONTRACT_VERSION}. Update the workspace runtime — its live session updates cannot be applied.`
}

type MismatchEvent = { type: string; properties: Record<string, unknown> }

/**
 * The compat events that carry a contract mismatch to the UI.
 *
 * `session.error` is the provider's existing error surface: it clears the
 * session's busy status (so the session stops looking frozen) and appends a
 * visible error notification. The `runtime.diagnostic` frame carries the
 * machine-readable code alongside it, mirroring the replay-gap notice.
 */
export function runtimeContractMismatchEvents(input: {
  contractVersion: unknown
  sessionID: string
}): MismatchEvent[] {
  const message = runtimeContractMismatchMessage(input.contractVersion)
  return [
    { type: "runtime.diagnostic", properties: { sessionID: input.sessionID, code: "runtime.contract_version_mismatch", message, severity: "error" } },
    { type: "session.error", properties: { sessionID: input.sessionID, error: { name: "UnknownError", data: { message } } } },
  ]
}

/**
 * Report an undecodable frame once per incompatible contract version.
 *
 * Returns the version that has now been reported (or the one already reported),
 * so the caller can keep its latch without re-deriving it: a mismatching runtime
 * emits EVERY frame that way, and the diagnostic must not repeat per frame.
 */
export function reportRuntimeContractMismatch(input: {
  frame: unknown
  reported: unknown
  serverUrl: string
  live?: LiveSession
  publish: (directory: EventDirectory, event: MismatchEvent) => void
}) {
  const mismatch = runtimeContractMismatch(input.frame)
  if (!mismatch || mismatch.contractVersion === input.reported) return input.reported
  console.error(
    "[global-sdk] incompatible runtime event contract",
    runtimeContractMismatchMessage(mismatch.contractVersion),
    { url: input.serverUrl },
  )
  const live = input.live
  if (live?.sessionID && live.sessionID !== "route") {
    const directory = eventDirectoryForLiveSession({ directory: live.directory ?? "", liveSession: live })
    for (const event of runtimeContractMismatchEvents({ contractVersion: mismatch.contractVersion, sessionID: live.sessionID })) {
      input.publish(directory, event)
    }
  }
  return mismatch.contractVersion
}
