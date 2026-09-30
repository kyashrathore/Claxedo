import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createAgentEventRuntime, type AgentEventRuntime } from "../../translate/runtime"
import { claudeChildCorrelationKey, claudeSdkAdapter, claudeSubagentObservations, createClaudeTaskLedger, foldNestedSubagentFrame,
  type ClaudeSdkAdapterState, type ClaudeTaskLedger } from "./translate"
import type { RoutedEvent, TurnBroker, TurnInput } from "../../contract"
import { routedIngest } from "../../translate/ingest"

export function claudeTranslator(threadId: string, todos: TurnInput["todos"] = [], tasks: ClaudeTaskLedger = createClaudeTaskLedger()) {
  const seed = todos.filter((todo) => todo.id).map((todo) => ({ id: todo.id!, description: todo.content, status: todo.status }))
  return { runtime: createAgentEventRuntime({ harness: "claude", threadId, adapter: claudeSdkAdapter(seed) }), tasks }
}

export function claudeChildFrameKey(message: SDKMessage, tasks: ClaudeTaskLedger): string | undefined {
  if (message.type === "tool_progress") return undefined
  const key = claudeChildCorrelationKey(message)
  return key === undefined ? undefined : tasks.firstLevelSubagent(key)
}

export async function translateClaude(message: SDKMessage, runtime: AgentEventRuntime<ClaudeSdkAdapterState>, tasks: ClaudeTaskLedger,
  broker: Pick<TurnBroker, "observeSubagent" | "associateChild">): Promise<RoutedEvent[]> {
  const key = claudeChildFrameKey(message, tasks)
  const folded = foldNestedSubagentFrame(message, tasks)
  for (const observation of claudeSubagentObservations(folded, tasks)) {
    const child = await broker.observeSubagent(observation)
    if (child && observation.toolCallId) broker.associateChild(observation.toolCallId, child)
  }
  return routedIngest(runtime, { source: "claude.sdk", method: `claude/${message.type}`, payload: folded }, {
    method: `claude.${message.type}`, target: key ? { kind: "child", correlationKey: key } : { kind: "parent" },
  })
}
