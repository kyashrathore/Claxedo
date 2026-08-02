import { cloneSnapshotValue } from "../../core/state"
import type { ToolDisplay } from "../../contracts/agent-runtime-event"

export type OpencodeCompatProjectionState = {
  assistantMsgId?: string
  accumulatedText: string
  accumulatedThinkingText: string
  proposedPlanText: string
  toolNamesByCallId: Record<string, string>
  partIdMap: Record<string, string>
  toolInputsByCallId: Record<string, Record<string, unknown>>
  toolDisplaysByCallId: Record<string, ToolDisplay>
  toolMetadataByCallId: Record<string, Record<string, unknown>>
  toolStatusByCallId: Record<string, "pending" | "running" | "completed" | "error">
  toolOutputsByCallId: Record<string, string>
  toolErrorsByCallId: Record<string, string>
  textPartSeq: number
  reasoningPartSeq: number
  splitText: boolean
  splitReasoning: boolean
}

export function createOpencodeCompatProjectionState(
  initial?: Partial<OpencodeCompatProjectionState>,
): OpencodeCompatProjectionState {
  return {
    assistantMsgId: initial?.assistantMsgId,
    accumulatedText: initial?.accumulatedText ?? "",
    accumulatedThinkingText: initial?.accumulatedThinkingText ?? "",
    proposedPlanText: initial?.proposedPlanText ?? "",
    toolNamesByCallId: cloneSnapshotValue(initial?.toolNamesByCallId ?? {}),
    partIdMap: cloneSnapshotValue(initial?.partIdMap ?? {}),
    toolInputsByCallId: cloneSnapshotValue(initial?.toolInputsByCallId ?? {}),
    toolDisplaysByCallId: cloneSnapshotValue(initial?.toolDisplaysByCallId ?? {}),
    toolMetadataByCallId: cloneSnapshotValue(initial?.toolMetadataByCallId ?? {}),
    toolStatusByCallId: cloneSnapshotValue(initial?.toolStatusByCallId ?? {}),
    toolOutputsByCallId: cloneSnapshotValue(initial?.toolOutputsByCallId ?? {}),
    toolErrorsByCallId: cloneSnapshotValue(initial?.toolErrorsByCallId ?? {}),
    textPartSeq: initial?.textPartSeq ?? 0,
    reasoningPartSeq: initial?.reasoningPartSeq ?? 0,
    splitText: initial?.splitText ?? false,
    splitReasoning: initial?.splitReasoning ?? false,
  }
}
