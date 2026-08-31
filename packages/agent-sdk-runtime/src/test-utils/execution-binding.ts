import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStreamEvent, PromptInput } from "../index"

export function executionBinding(
  sessionId: string,
  directory: string | undefined,
  connectionId = "test-harness",
): AgentExecutionBinding {
  return {
    workspaceId: "test-workspace",
    directory: directory ?? "",
    sessionId,
    connectionId,
    upstreamSessionId: sessionId,
  }
}

export function executeTestTurn(
  adapter: { executeTurn?: (binding: AgentExecutionBinding, input: PromptInput) => AsyncIterable<AgentRuntimeStreamEvent> },
  sessionId: string,
  input: PromptInput,
  directory: string | undefined,
) {
  if (!adapter.executeTurn) throw new Error("test adapter does not support bound execution")
  return adapter.executeTurn(executionBinding(sessionId, directory), input)
}
