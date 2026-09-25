import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createAgentEventRuntime, type AgentEventRuntime } from "@claxedo/agent-event-runtime"
import { claudeChildCorrelationKey, claudeSdkAdapter, claudeSubagentObservations, createClaudeTaskLedger, foldNestedSubagentFrame,
  type ClaudeSdkAdapterState, type ClaudeTaskLedger } from "@claxedo/agent-event-runtime/harnesses/claude"
import type { RoutedEvent, TurnBroker } from "../../contract"
import { unrecognizedEvent } from "../../translate/unrecognized"

const knownTypes = { assistant: true, auth_status: true, conversation_reset: true, prompt_suggestion: true,
  rate_limit_event: true, result: true, stream_event: true, system: true, tool_progress: true,
  tool_use_summary: true, user: true } satisfies Record<SDKMessage["type"], true>

export function claudeTranslator(threadId: string) {
  return { runtime: createAgentEventRuntime({ harness: "claude", threadId, adapter: claudeSdkAdapter() }), tasks: createClaudeTaskLedger() }
}

export async function translateClaude(message: SDKMessage, runtime: AgentEventRuntime<ClaudeSdkAdapterState>, tasks: ClaudeTaskLedger,
  broker: TurnBroker): Promise<RoutedEvent[]> {
  if (!(message.type in knownTypes)) return [unknownClaude(message, `claude/${message.type}`)]
  const folded = foldNestedSubagentFrame(message, tasks)
  for (const observation of claudeSubagentObservations(folded, tasks)) await broker.observeSubagent(observation)
  const key = claudeChildCorrelationKey(folded)
  const events = runtime.ingest({ source: "claude.sdk", method: `claude/${message.type}`, payload: folded }).events
  return events.map((event) => ({ event, route: key ? { kind: "child", correlationKey: key } : { kind: "parent" },
    source: { dir: "in", method: `claude.${message.type}` } }))
}

export function unknownClaude(message: unknown, method: string): RoutedEvent {
  return { event: unrecognizedEvent("claude.sdk", method, message), route: { kind: "parent" } }
}
