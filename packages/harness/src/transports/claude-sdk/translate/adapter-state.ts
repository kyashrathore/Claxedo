import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterResult } from "../../../translate/adapter"
import type { ClaudeTrackedTask } from "./task-tracking"

export type ClaudeBlockState = {
  type: "text" | "thinking" | "tool"
  fallbackText?: string
  emittedText?: boolean
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
  partialInputJson?: string
  streamedInputJson?: string
}

export type ClaudeRequestUsage = {
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cacheWrite1h: number | null
  model?: string
}

export type ClaudeSdkAdapterState = {
  tasks?: Record<string, ClaudeTrackedTask>
  blocksByIndex: Record<string, ClaudeBlockState>
  toolsById: Record<string, ClaudeBlockState>
  streamedAssistantTextByOwner: Record<string, string>
  reconciledAssistantTextByMessageId: Record<string, string>
  cwd?: string
  lastKnownContextWindow?: number
  requestUsageByOwner?: Record<string, Record<string, ClaudeRequestUsage>>
  streamingRequestByOwner?: Record<string, string>
  lastMainRequest?: string
  rejectedWindow?: { limitName?: string; resetsAt?: number | null }
}

export type ClaudeTranslation = HarnessEventAdapterResult<ClaudeSdkAdapterState> | AgentRuntimeEvent[]

export function withoutKey(row: Record<string, string>, key: string) {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key))
}
