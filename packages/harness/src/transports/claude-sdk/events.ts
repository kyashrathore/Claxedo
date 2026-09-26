import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createAgentEventRuntime, type AgentEventRuntime } from "../../translate/runtime"
import { claudeChildCorrelationKey, claudeSdkAdapter, claudeSubagentObservations, createClaudeTaskLedger, foldNestedSubagentFrame,
  type ClaudeSdkAdapterState, type ClaudeTaskLedger } from "./translate"
import type { RoutedEvent, TurnBroker, TurnInput } from "../../contract"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { routedIngest } from "../../translate/ingest"

const knownTypes = { assistant: true, auth_status: true, conversation_reset: true, prompt_suggestion: true,
  rate_limit_event: true, result: true, stream_event: true, system: true, tool_progress: true,
  tool_use_summary: true, user: true } satisfies Record<SDKMessage["type"], true>

export function claudeTranslator(threadId: string, todos: TurnInput["todos"] = []) {
  const seed = todos.filter((todo) => todo.id).map((todo) => ({ id: todo.id!, description: todo.content, status: todo.status }))
  return { runtime: createAgentEventRuntime({ harness: "claude", threadId, adapter: claudeSdkAdapter(seed) }), tasks: createClaudeTaskLedger() }
}

export async function translateClaude(message: SDKMessage, runtime: AgentEventRuntime<ClaudeSdkAdapterState>, tasks: ClaudeTaskLedger,
  broker: TurnBroker): Promise<RoutedEvent[]> {
  if (!(message.type in knownTypes)) return [unknownClaude(message, `claude/${message.type}`)]
  const folded = foldNestedSubagentFrame(message, tasks)
  const key = claudeChildCorrelationKey(folded)
  for (const observation of claudeSubagentObservations(folded, tasks)) {
    const child = await broker.observeSubagent(observation)
    const correlationKey = key ?? observation.toolCallId
    if (child && correlationKey) broker.associateChild(correlationKey, child)
  }
  return routedIngest(runtime, { source: "claude.sdk", method: `claude/${message.type}`, payload: folded }, {
    method: `claude.${message.type}`, target: key ? { kind: "child", correlationKey: key } : { kind: "parent" },
  })
}

export function unknownClaude(message: unknown, method: string): RoutedEvent {
  return { event: unrecognizedEvent("claude.sdk", method, message), route: { kind: "parent" } }
}
