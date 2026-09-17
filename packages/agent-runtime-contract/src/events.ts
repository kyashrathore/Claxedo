import type {
  AgentConfigOption,
  AgentContentPart,
  AgentMessageInfo,
  AgentPermission,
  AgentQuestion,
  AgentSnapshotFileDiff,
  AgentTodo,
} from "./content"
import type { AgentRuntimeStatus } from "./availability"
import type { AgentSubagentUpdate, RuntimeGoalSnapshot } from "./subagents"

export type RuntimeTokenUsage = {
  input: number | null
  output: number | null
  reasoning: number | null
  cache: { read: number | null; write: number | null }
}

export type RuntimeUsageObservation = {
  kind: "cumulative" | "delta"
  tokens: RuntimeTokenUsage
  sequence?: number
  providerObservationId?: string
  nativeSessionId?: string
  observedAt?: number
}

export type AgentPresentationEvent =
  | { id: string; type: "message.updated"; properties: { sessionID: string; info: AgentMessageInfo & { sessionID: string } } }
  | { id: string; type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { id: string; type: "message.part.updated"; properties: { sessionID: string; part: AgentContentPart; time: number } }
  | { id: string; type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }
  | { id: string; type: "message.part.delta"; properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string } }
  | { type: "message.completed"; properties: { sessionID: string; messageID: string } }
  | { id: string; type: "permission.asked"; properties: AgentPermission }
  | { id: string; type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" } }
  | { id: string; type: "question.asked"; properties: AgentQuestion }
  | { id: string; type: "question.replied"; properties: { sessionID: string; requestID: string; answers: string[][] } }
  | { id: string; type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  | { id: string; type: "todo.updated"; properties: { sessionID: string; todos: AgentTodo[] } }
  | { id: string; type: "session.status"; properties: { sessionID: string; status: AgentRuntimeStatus } }
  | { id: string; type: "session.idle"; properties: { sessionID: string } }
  | { id: string; type: "session.error"; properties: { sessionID?: string; error?: { name: string; data: Record<string, unknown> & { message?: string } } } }
  | { id: string; type: "session.updated"; properties: { sessionID: string; info: import("./sessions").AgentSession } }
  | { id: string; type: "session.diff"; properties: { sessionID: string; diff: AgentSnapshotFileDiff[] } }
  | { id: string; type: "session.compacted"; properties: { sessionID: string } }
  | { type: "session.agent"; properties: { sessionID: string; agentId: string } }
  | { type: "session.config"; properties: { sessionID: string; options: AgentConfigOption[] } }
  | { type: "session.usage"; properties: { sessionID: string; messageID?: string; contextSize: number; contextUsed: number; observation?: RuntimeUsageObservation; cost?: { amount: number; currency: string } } }
  | { id?: string; type: "subagent.updated"; properties: { sessionID: string; update: AgentSubagentUpdate } }
  | { id?: string; type: "goal.updated"; properties: { sessionID: string; goal: RuntimeGoalSnapshot } }
  | { id?: string; type: "goal.cleared"; properties: { sessionID: string } }
  | { id?: string; type: "runtime.diagnostic"; properties: { sessionID: string; harness?: string; threadId?: string; projection?: string; phase?: "ingest" | "terminalize"; code: string; message: string; severity: "debug" | "info" | "warn" | "error"; eventType?: string; issues?: string[]; details?: unknown; auth?: unknown; rateLimit?: unknown; mcp?: unknown; diagnostic?: unknown; raw?: unknown } }
  | { id: string; type: "server.connected"; properties: Record<string, unknown> }
  | { type: "server.heartbeat"; properties: Record<string, unknown> }

export type AgentPresentationEventType = AgentPresentationEvent["type"]

export const AGENT_PRESENTATION_EVENT_TYPE_REGISTRY = {
  "message.updated": true,
  "message.removed": true,
  "message.part.updated": true,
  "message.part.removed": true,
  "message.part.delta": true,
  "message.completed": true,
  "permission.asked": true,
  "permission.replied": true,
  "question.asked": true,
  "question.replied": true,
  "question.rejected": true,
  "todo.updated": true,
  "session.status": true,
  "session.idle": true,
  "session.error": true,
  "session.updated": true,
  "session.diff": true,
  "session.compacted": true,
  "session.agent": true,
  "session.config": true,
  "session.usage": true,
  "subagent.updated": true,
  "goal.updated": true,
  "goal.cleared": true,
  "runtime.diagnostic": true,
  "server.connected": true,
  "server.heartbeat": true,
} satisfies Record<AgentPresentationEventType, true>

/** Sound because the registry is `satisfies Record<AgentPresentationEventType, true>`: its keys are exactly the union. */
export function isAgentPresentationEventType(value: string): value is AgentPresentationEventType {
  return Object.hasOwn(AGENT_PRESENTATION_EVENT_TYPE_REGISTRY, value)
}

export const AGENT_PRESENTATION_EVENT_TYPES: AgentPresentationEventType[] =
  Object.keys(AGENT_PRESENTATION_EVENT_TYPE_REGISTRY).filter(isAgentPresentationEventType)

export type AgentEventEnvelope<Event extends AgentPresentationEvent = AgentPresentationEvent> = {
  directory: string
  payload: Event
}

export type RawHarnessEvent = { source: string; method?: string; payload: unknown; receivedAt?: number }

export type RuntimeQuestion = {
  text: string
  options?: string[]
  optionDescriptions?: Record<string, string>
  header?: string
  multiple?: boolean
  custom?: boolean
}

export type AgentRuntimeEvent = ({ harness?: string; threadId?: string; raw?: RawHarnessEvent; diagnostics?: Array<{ code: string; message: string; severity: "debug" | "info" | "warn" | "error"; details?: Record<string, unknown> }> }) & (
  | { type: "text-delta"; delta: string }
  | { type: "thinking-delta"; delta: string }
  | { type: "user-message-delta"; messageId?: string; content: Record<string, unknown> & { type: string } }
  | { type: "tool-start"; toolCallId: string; toolName: string; kind?: string; display?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "tool-input"; toolCallId: string; input: unknown; display?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "tool-status"; toolCallId: string; status: "pending" | "running" | "completed" | "failed"; display?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "tool-content"; toolCallId: string; content: Record<string, unknown> & { type: string }; display?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "tool-output"; toolCallId: string; output: unknown; display?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "tool-error"; toolCallId: string; error: string; display?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "file-diff"; toolCallId?: string; path: string; oldText?: string; newText: string }
  | { type: "step-start"; newMessageId: string }
  | { type: "permission-request"; requestId: string; tool: string; paths: string[] }
  | { type: "question"; requestId: string; questions: RuntimeQuestion[] }
  | { type: "question-answered"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "proposed-plan-delta"; delta: string }
  | { type: "proposed-plan-complete"; planMarkdown: string }
  | { type: "todo-update"; todos: Array<{ id: string; description: string; status: string; priority?: string }> }
  | { type: "session-status"; status: "busy" | "idle" | "error" | "recovering" }
  | { type: "session-compaction"; phase: "started" | "completed"; reason?: string; summary?: string; metadata?: Record<string, unknown> }
  | { type: "harness-notice"; code: string; message: string; severity?: "debug" | "info" | "warn" | "error"; details?: unknown }
  | { type: "auth-status"; status: "authenticated" | "unauthenticated" | "unknown"; authMode?: string | null; planType?: string | null; metadata?: Record<string, unknown> }
  | { type: "rate-limit"; status: "ok" | "limited"; usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null; limitId?: string | null; limitName?: string | null; reason?: string | null; metadata?: Record<string, unknown> }
  | { type: "mcp-server-status"; serverName: string; status: "starting" | "ready" | "failed" | "cancelled"; error?: string | null }
  | { type: "subagent-updated"; subagentKey: string; revision: number; [key: string]: unknown }
  | { type: "finish"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "image-delta" | "audio-delta" | "thinking-audio-delta"; mimeType: string; data: string }
  | { type: "resource-link-delta" | "thinking-resource-link-delta"; uri: string; name: string; mimeType?: string; title?: string }
  | { type: "resource-delta"; resource: unknown; channel: "assistant" | "thinking" }
  | { type: "tool-location"; toolCallId: string; locations: Array<{ path: string; line?: number }> }
  | { type: "tool-terminal"; toolCallId: string; terminalId: string }
  | { type: "available-commands-update"; commands: Array<{ name: string; description?: string; input?: unknown }> }
  | { type: "session-agent"; agentId: string }
  | { type: "config-update"; options: AgentConfigOption[] }
  | { type: "session-info"; title?: string | null; updatedAt?: string | null; parentID?: string }
  | { type: "session-title"; title: string; titleSource?: "harness" | "user" }
  | { type: "usage"; contextSize: number; contextUsed: number; observation?: RuntimeUsageObservation; cost?: { amount: number; currency: string } }
  | { type: "diagnostic"; diagnostic: { code: string; message: string; severity: "debug" | "info" | "warn" | "error"; details?: unknown } }
)
