import type { SDKMessage } from "@cursor/sdk"
import type { RuntimeTokenUsage } from "@claxedo/agent-runtime-contract"
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

function sum(previous: number | null, next: number | null) {
  return previous === null && next === null ? null : (previous ?? 0) + (next ?? 0)
}

function added(previous: RuntimeTokenUsage | undefined, next: RuntimeTokenUsage): RuntimeTokenUsage {
  if (!previous) return next
  return {
    input: sum(previous.input, next.input),
    output: sum(previous.output, next.output),
    reasoning: sum(previous.reasoning, next.reasoning),
    cache: { read: sum(previous.cache.read, next.cache.read), write: sum(previous.cache.write, next.cache.write) },
  }
}

export function summedUsageEvents(state: CursorSdkAdapterState, message: UsageMessage): CursorTranslation {
  const tokens = added(own(state.usageByRunId, message.run_id), turnTokens(message.usage))
  return {
    state: { ...state, usageByRunId: boundKeyedRecord({ ...state.usageByRunId, [message.run_id]: tokens }, RETAINED_WIRE_KEYS_MAX) },
    events: [{ type: "usage", contextSize: 0, contextUsed: 0, observation: { kind: "cumulative", providerObservationId: message.run_id, tokens } }],
  }
}
