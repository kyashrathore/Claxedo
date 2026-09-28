import type { PromptResponse } from "@agentclientprotocol/sdk"
import type { RoutedEvent } from "../../contract"

export type AcpContextOccupancy = { size: number; used: number }

export function acpPromptUsage(result: PromptResponse, nativeSessionId: string, context: AcpContextOccupancy | undefined): RoutedEvent[] {
  const usage = result.usage
  if (usage && [usage.totalTokens, usage.inputTokens, usage.outputTokens, usage.thoughtTokens,
    usage.cachedReadTokens, usage.cachedWriteTokens].some((value) => value != null && value > 0)) {
    return [{ event: { type: "usage", contextSize: context?.size ?? 0, contextUsed: context?.used ?? 0,
      observation: { kind: "cumulative", nativeSessionId,
        tokens: { input: usage.inputTokens, output: usage.outputTokens, reasoning: usage.thoughtTokens ?? null,
          cache: { read: usage.cachedReadTokens ?? null, write: usage.cachedWriteTokens ?? null } } } },
      source: { dir: "in", method: "prompt.result.usage" } }]
  }
  if (!["end_turn", "max_tokens", "max_turn_requests"].includes(result.stopReason)) return []
  return [acpUsageUnavailable(`ACP agent returned no token usage for a completed turn (stopReason: ${result.stopReason})`, "prompt.result.usage")]
}

export function acpUsageUnavailable(why: string, method: string): RoutedEvent {
  return { event: { type: "diagnostic", diagnostic: { code: "acp_prompt_usage_missing", severity: "warn", source: "acp-adapter",
    message: `${why}; the turn meters as unavailable` } }, source: { dir: "in", method } }
}
