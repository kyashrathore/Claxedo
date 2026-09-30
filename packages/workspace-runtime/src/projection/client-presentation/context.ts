import type { AgentContentPart, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import { messagePartUpdated, withDir } from "../presentation-events"
import type { ClientPresentationProjectionState } from "./state"

export type CompatContext = ClientPresentationProjectionState & {
  sessionId: string
  directory: string
  assistantMsgId: string
  /**
   * The reply id the TURN was opened with. `assistantMsgId` follows the engine
   * as a turn steps onto new messages; this one does not, so the user message
   * the turn answers stays recoverable from it for every step.
   */
  turnAssistantMsgId: string
}

export function seqId(ctx: CompatContext, key: string, scoped = key): string {
  if (!ctx.partIdMap.has(key)) {
    const seq = ctx.partIdMap.size
    ctx.partIdMap.set(key, `${String(seq).padStart(6, "0")}_${scoped}`)
  }
  return ctx.partIdMap.get(key) ?? key
}

export function seen(ctx: CompatContext, id: string): boolean {
  return ctx.partIdMap.has(id)
}

export function partEvent(directory: string, part: AgentContentPart, time: number): AgentEventEnvelope {
  return withDir(directory, messagePartUpdated(part, time))
}
