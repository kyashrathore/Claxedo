import type { SDKMessage } from "@cursor/sdk"
import { addTokenUsage, unknownTokenUsage, type RuntimeTokenUsage } from "@claxedo/agent-runtime-contract"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import type { CursorSdkAdapterState, CursorTranslation } from "./state"

type UsageMessage = Extract<SDKMessage, { type: "usage" }>

function turnTokens(usage: UsageMessage["usage"]): RuntimeTokenUsage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens ?? null,
    cache: { read: usage.cacheReadTokens, write: usage.cacheWriteTokens },
  }
}

export function summedUsageEvents(state: CursorSdkAdapterState, message: UsageMessage): CursorTranslation {
  const tokens = addTokenUsage(own(state.usageByRunId, message.run_id) ?? unknownTokenUsage(), turnTokens(message.usage))
  return {
    state: { ...state, usageByRunId: boundKeyedRecord({ ...state.usageByRunId, [message.run_id]: tokens }, RETAINED_WIRE_KEYS_MAX) },
    events: [{ type: "usage", contextSize: 0, contextUsed: 0, observation: { kind: "cumulative", providerObservationId: message.run_id, tokens } }],
  }
}
