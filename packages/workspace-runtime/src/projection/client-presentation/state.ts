import type { RuntimeToolAttachment, ToolDisplay } from "@claxedo/agent-runtime-contract"

export const RETAINED_TOOL_CALLS_MAX = 256
export const RETAINED_PART_IDS_MAX = 1024

export type OpenReasoningPart = {
  readonly partId: string
  readonly messageId: string
  readonly start: number
  readonly text: string
}

/**
 * The notice parts a turn has drawn. Mutated in place through the context, so
 * it is cloned whole with the rest of the state and never reassigned.
 */
export type NoticeProjectionState = {
  noticeCount: number
  runningCompactionPartId?: string
  /** A harness retry the session status shows until the reply's next content. */
  retrying: boolean
}

export type ResponseMembers = {
  parts: Array<{ messageID: string; partID: string }>
  toolCallIds: string[]
}

/** The model response the turn is writing, and what each response wrote, so a retraction names exactly its content. */
export type ResponseProjectionState = {
  current?: string
  members: Map<string, ResponseMembers>
}

export type ClientPresentationProjectionState = {
  assistantMsgId?: string
  /**
   * The assistant message id this projection has already announced a
   * `message.updated` row for. Kept as the id rather than a flag so a turn that
   * retargets its reply announces the new row instead of hanging its parts off
   * an envelope the consumer never received.
   */
  announcedAssistantMsgId?: string
  /**
   * The user message id this projection has already announced a row for. The
   * lane carries the turn's prompt as `user-message-delta` chunks and never a
   * row for it, so the first chunk opens the row its parts hang from.
   */
  announcedUserMsgId?: string
  /** The agent the lane last named (`session-agent`), for the announced row. */
  agentId: string
  accumulatedText: string
  accumulatedThinkingText: string
  proposedPlanText: string
  /**
   * Runtime `toolCallId`s are wire data, so every per-call store is a `Map`:
   * a `Record` would let a `"__proto__"` id read inherited members or rewrite
   * the container's prototype. Entries are bounded and the oldest evict.
   */
  toolNamesByCallId: Map<string, string>
  partIdMap: Map<string, string>
  toolInputsByCallId: Map<string, Record<string, unknown>>
  toolDisplaysByCallId: Map<string, ToolDisplay>
  toolMetadataByCallId: Map<string, Record<string, unknown>>
  toolStatusByCallId: Map<string, "pending" | "running" | "completed" | "error">
  toolOutputsByCallId: Map<string, string>
  toolAttachmentsByCallId: Map<string, RuntimeToolAttachment[]>
  toolErrorsByCallId: Map<string, string>
  textPartSeq: number
  reasoningPartSeq: number
  splitText: boolean
  splitReasoning: boolean
  /** The reasoning part still streaming; the next content event ends it with `time.end`. */
  openReasoning?: OpenReasoningPart
  notices: NoticeProjectionState
  responses: ResponseProjectionState
}

function keyedMap<V>(value: Map<string, V> | undefined): Map<string, V> {
  return value ? structuredClone(value) : new Map()
}

export function createClientPresentationProjectionState(
  initial?: Partial<ClientPresentationProjectionState>,
): ClientPresentationProjectionState {
  return {
    assistantMsgId: initial?.assistantMsgId,
    announcedAssistantMsgId: initial?.announcedAssistantMsgId,
    announcedUserMsgId: initial?.announcedUserMsgId,
    agentId: initial?.agentId ?? "",
    accumulatedText: initial?.accumulatedText ?? "",
    accumulatedThinkingText: initial?.accumulatedThinkingText ?? "",
    proposedPlanText: initial?.proposedPlanText ?? "",
    toolNamesByCallId: keyedMap(initial?.toolNamesByCallId),
    partIdMap: keyedMap(initial?.partIdMap),
    toolInputsByCallId: keyedMap(initial?.toolInputsByCallId),
    toolDisplaysByCallId: keyedMap(initial?.toolDisplaysByCallId),
    toolMetadataByCallId: keyedMap(initial?.toolMetadataByCallId),
    toolStatusByCallId: keyedMap(initial?.toolStatusByCallId),
    toolOutputsByCallId: keyedMap(initial?.toolOutputsByCallId),
    toolAttachmentsByCallId: keyedMap(initial?.toolAttachmentsByCallId),
    toolErrorsByCallId: keyedMap(initial?.toolErrorsByCallId),
    textPartSeq: initial?.textPartSeq ?? 0,
    reasoningPartSeq: initial?.reasoningPartSeq ?? 0,
    splitText: initial?.splitText ?? false,
    splitReasoning: initial?.splitReasoning ?? false,
    openReasoning: initial?.openReasoning,
    notices: initial?.notices ? structuredClone(initial.notices) : { noticeCount: 0, retrying: false },
    responses: initial?.responses ? structuredClone(initial.responses) : { members: new Map() },
  }
}
