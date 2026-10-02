import type { BackgroundWork } from "./background-work"
import type { AgentSubagentUpdate, RuntimeGoalSnapshot } from "./subagents"
import type { RuntimeQuestion, RuntimeUsageObservation } from "./events"
import type { AgentSessionCommand } from "./sessions"
import type { RuntimeToolCallContent } from "./runtime-content"
import type { FirstTurnErrorClass } from "./turn-error-classes"
import type { TurnAccount } from "./turn-account"
import type { RuntimeDiagnostic } from "./diagnostics"
import type { RawHarnessEvent } from "./raw-harness-event"

export const AGENT_RUNTIME_EVENT_CONTRACT_VERSION = 8

export type RuntimeStatus = "busy" | "idle" | "error" | "recovering"
export type RuntimeToolStatus = "pending" | "running" | "completed" | "failed"
export type RuntimeNoticeSeverity = "debug" | "info" | "warn" | "error"

export type SubagentUpdatedEvent = { type: "subagent-updated" } & AgentSubagentUpdate

export type ToolIntent =
  | "shell"
  | "read"
  | "lint"
  | "edit"
  | "search"
  | "list"
  | "fetch"
  | "move"
  | "delete"
  | "reasoning"
  | "task"
  | "todos"
  | "question"
  | "mcp"
  | "image"
  | "computer"
  | "switch_mode"
  | "generic"

type RuntimeEventMeta = {
  harness?: string
  threadId?: string
  raw?: RawHarnessEvent
  diagnostics?: RuntimeDiagnostic[]
}

/**
 * Preserve supplied image bytes inline. Native image-view results that report
 * only a path use tool-file: an absolute reference read by the owning runtime.
 * Existing workspace-file records remain workspace-relative.
 */
export type RuntimeToolAttachment = { mime: string; filename?: string } & (
  | { kind: "tool-file"; path: string }
  | { kind: "workspace-file"; path: string; sourcePath: string }
  | { kind: "inline"; url: string }
  | { kind: "unretained"; sourcePath?: string; bytes: number }
)

export type ToolDisplay = {
  kind?: string
  intent?: ToolIntent
  mode?: string
  summary?: string
  description?: string
  command?: string
  path?: string
  filePath?: string
  pattern?: string
  query?: string
  url?: string
  sourcePath?: string
  targetPath?: string
  sessionId?: string
  agentId?: string
  subagentType?: unknown
  durationMs?: number
  files?: string[]
  locations?: Array<{ path: string; line?: number }>
  input?: Record<string, unknown>
}

export type AgentRuntimeEvent = RuntimeEventMeta & (
  | { type: "text-delta"; delta: string }
  | { type: "thinking-delta"; delta: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; kind?: string; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-input"; toolCallId: string; input: unknown; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-status"; toolCallId: string; status: RuntimeToolStatus; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-content"; toolCallId: string; content: RuntimeToolCallContent; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-output"; toolCallId: string; output: unknown; attachments?: RuntimeToolAttachment[]; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-error"; toolCallId: string; error: string; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "file-diff"; toolCallId?: string; path: string; oldText?: string; newText: string }
  | { type: "step-start"; newMessageId: string }
  /** The provider took this submitted message into its conversation; `messageId` is the id Claxedo submitted it under. */
  | { type: "input-incorporated"; messageId: string }
  | { type: "permission-request"; requestId: string; tool: string; paths: string[]; details?: { command?: string; reason?: string }; options?: { id: string; label: string; description?: string }[] }
  | { type: "question"; requestId: string; questions: RuntimeQuestion[] }
  | { type: "question-answered"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "proposed-plan-delta"; delta: string }
  | { type: "proposed-plan-complete"; planMarkdown: string }
  | { type: "todo-update"; todos: Array<{ id: string; description: string; status: string; priority?: string }> }
  | { type: "session-status"; status: RuntimeStatus }
  | { type: "session-compaction"; phase: "started" | "completed"; reason?: string; summary?: string; metadata?: Record<string, unknown> }
  | { type: "harness-notice"; code: string; message: string; severity?: RuntimeNoticeSeverity; details?: unknown; eventId?: string }
  | { type: "agent-message"; eventId: string; sender: string; senderName?: string; message: string; senderTaskId?: string; sourceSessionId?: string }
  /** The harness is retrying a failed model request itself; `attempt` and `delayMs` only when it reports them. */
  | { type: "session-retry"; message: string; attempt?: number; delayMs?: number }
  /** The model began a response; the content after it, until the next start, is that response's. */
  | { type: "response-start"; responseId: string }
  /** The harness withdrew these responses; their content stays on record, marked withdrawn. */
  | { type: "response-retracted"; responseIds: string[]; reason: string }
  /** The harness discarded its conversation (Claude's `/clear`); the turns after it start from fresh context in the same session. */
  | { type: "conversation-reset"; trigger: string }
  | { type: "auth-status"; status: "authenticated" | "unauthenticated" | "unknown"; authMode?: string | null; planType?: string | null; metadata?: Record<string, unknown> }
  | { type: "rate-limit"; status: "ok" | "limited"; usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null; limitId?: string | null; limitName?: string | null; reason?: string | null; metadata?: Record<string, unknown> }
  | { type: "mcp-server-status"; serverName: string; status: "starting" | "ready" | "failed" | "cancelled"; error?: string | null }
  | { type: "goal-updated"; sessionId: string; goal: RuntimeGoalSnapshot }
  | { type: "goal-cleared"; sessionId: string }
  | SubagentUpdatedEvent
  | { type: "finish"; sessionId: string }
  /** The turn ended because it was stopped. Its own terminal, never inferred from `session-status` idle. */
  | { type: "cancelled"; sessionId: string }
  /**
   * `errorClass` is set only from the harness's own structured error, never
   * guessed from `error`; `account` is the one the turn was launched on.
   */
  | { type: "error"; error: string; errorClass?: FirstTurnErrorClass; account?: TurnAccount }
  | { type: "image-delta"; mimeType: string; data: string }
  | { type: "audio-delta"; mimeType: string; data: string }
  | { type: "resource-link-delta"; uri: string; name: string; mimeType?: string; title?: string }
  | { type: "thinking-audio-delta"; mimeType: string; data: string }
  | { type: "thinking-resource-link-delta"; uri: string; name: string; mimeType?: string; title?: string }
  | { type: "resource-delta"; resource: unknown; channel: "assistant" | "thinking" }
  | { type: "tool-location"; toolCallId: string; locations: Array<{ path: string; line?: number }> }
  | { type: "tool-terminal"; toolCallId: string; terminalId: string }
  | { type: "available-commands-update"; commands: AgentSessionCommand[] }
  | { type: "session-agent"; agentId: string }
  | { type: "config-update"; options: Array<{ id: string; name: string; category?: string; type: "select" | "boolean"; currentValue: string | boolean; selectOptions?: Array<{ id: string; name: string }> }> }
  | {
      type: "session-info"
      title?: string | null
      updatedAt?: string | null
      parentID?: string
      /** Authoritative placement identity for non-workspace session hosts. */
      sessionRef?: string
      host?: "workspace"
      workspaceID?: string
    }
  | { type: "session-title"; title: string; titleSource?: "harness" | "user" }
  /** The work the harness runs for the session outside any turn (background agents, shells, other tasks), restated whole whenever it changes; all zero once it settled. Never a turn state. */
  | ({ type: "background-work" } & BackgroundWork)
  | {
      type: "usage"
      contextSize: number
      contextUsed: number
      observation?: RuntimeUsageObservation
      cost?: { amount: number; currency: string }
    }
  | { type: "diagnostic"; diagnostic: RuntimeDiagnostic }
)

export type AgentRuntimeEventType = AgentRuntimeEvent["type"]

export type AgentRuntimeEventOf<T extends AgentRuntimeEventType> = Extract<AgentRuntimeEvent, { type: T }>

export type AgentRuntimeEventInput<T extends AgentRuntimeEventType> = Omit<AgentRuntimeEventOf<T>, "type">

export const AGENT_RUNTIME_EVENT_TYPE_REGISTRY = {
  "text-delta": true,
  "thinking-delta": true,
  "tool-start": true,
  "tool-input": true,
  "tool-status": true,
  "tool-content": true,
  "tool-output": true,
  "tool-error": true,
  "file-diff": true,
  "step-start": true,
  "input-incorporated": true,
  "permission-request": true,
  question: true,
  "question-answered": true,
  "proposed-plan-delta": true,
  "proposed-plan-complete": true,
  "todo-update": true,
  "session-status": true,
  "session-compaction": true,
  "harness-notice": true,
  "agent-message": true,
  "session-retry": true,
  "response-start": true,
  "response-retracted": true,
  "conversation-reset": true,
  "auth-status": true,
  "rate-limit": true,
  "mcp-server-status": true,
  "goal-updated": true,
  "goal-cleared": true,
  "subagent-updated": true,
  finish: true,
  cancelled: true,
  error: true,
  "image-delta": true,
  "audio-delta": true,
  "resource-link-delta": true,
  "thinking-audio-delta": true,
  "thinking-resource-link-delta": true,
  "resource-delta": true,
  "tool-location": true,
  "tool-terminal": true,
  "available-commands-update": true,
  "session-agent": true,
  "config-update": true,
  "session-info": true,
  "session-title": true,
  "background-work": true,
  usage: true,
  diagnostic: true,
} satisfies Record<AgentRuntimeEventType, true>

/** Sound because the registry is `satisfies Record<AgentRuntimeEventType, true>`: its keys are exactly the union. */
export function isAgentRuntimeEventType(value: string): value is AgentRuntimeEventType {
  return Object.hasOwn(AGENT_RUNTIME_EVENT_TYPE_REGISTRY, value)
}

export const AGENT_RUNTIME_EVENT_TYPES: AgentRuntimeEventType[] =
  Object.keys(AGENT_RUNTIME_EVENT_TYPE_REGISTRY).filter(isAgentRuntimeEventType)

export const AGENT_RUNTIME_EVENT_FACTORY_TYPES = {
  textDelta: "text-delta",
  thinkingDelta: "thinking-delta",
  toolStart: "tool-start",
  toolInput: "tool-input",
  toolStatus: "tool-status",
  toolContent: "tool-content",
  toolOutput: "tool-output",
  toolError: "tool-error",
  fileDiff: "file-diff",
  stepStart: "step-start",
  inputIncorporated: "input-incorporated",
  permissionRequest: "permission-request",
  question: "question",
  questionAnswered: "question-answered",
  proposedPlanDelta: "proposed-plan-delta",
  proposedPlanComplete: "proposed-plan-complete",
  todoUpdate: "todo-update",
  sessionStatus: "session-status",
  sessionCompaction: "session-compaction",
  harnessNotice: "harness-notice",
  agentMessage: "agent-message",
  sessionRetry: "session-retry",
  responseStart: "response-start",
  responseRetracted: "response-retracted",
  conversationReset: "conversation-reset",
  authStatus: "auth-status",
  rateLimit: "rate-limit",
  mcpServerStatus: "mcp-server-status",
  goalUpdated: "goal-updated",
  goalCleared: "goal-cleared",
  subagentUpdated: "subagent-updated",
  finish: "finish",
  cancelled: "cancelled",
  error: "error",
  imageDelta: "image-delta",
  audioDelta: "audio-delta",
  resourceLinkDelta: "resource-link-delta",
  thinkingAudioDelta: "thinking-audio-delta",
  thinkingResourceLinkDelta: "thinking-resource-link-delta",
  resourceDelta: "resource-delta",
  toolLocation: "tool-location",
  toolTerminal: "tool-terminal",
  availableCommandsUpdate: "available-commands-update",
  sessionAgent: "session-agent",
  configUpdate: "config-update",
  sessionInfo: "session-info",
  sessionTitle: "session-title",
  backgroundWork: "background-work",
  usage: "usage",
  diagnostic: "diagnostic",
} as const satisfies Record<string, AgentRuntimeEventType>

type AgentRuntimeEventFactoryTypes = typeof AGENT_RUNTIME_EVENT_FACTORY_TYPES
type MissingAgentRuntimeEventFactory = Exclude<AgentRuntimeEventType, AgentRuntimeEventFactoryTypes[keyof AgentRuntimeEventFactoryTypes]>
type AssertEveryRuntimeEventHasFactory<T extends never> = T
type AgentRuntimeEventFactoriesFor<Types extends Record<string, AgentRuntimeEventType>> = {
  [Name in keyof Types]: (
    input: AgentRuntimeEventInput<Types[Name]>
  ) => AgentRuntimeEventOf<Types[Name]>
}
type _AgentRuntimeEventFactoryCoverage = AssertEveryRuntimeEventHasFactory<MissingAgentRuntimeEventFactory>

/**
 * One factory per runtime event type. Written out rather than generated so every
 * entry is checked against the union: `satisfies` rejects a missing name, an
 * unknown name, and a body whose payload does not match the event it names.
 */
export const agentRuntimeEvent = {
  textDelta: (input) => ({ type: "text-delta", ...input }),
  thinkingDelta: (input) => ({ type: "thinking-delta", ...input }),
  toolStart: (input) => ({ type: "tool-start", ...input }),
  toolInput: (input) => ({ type: "tool-input", ...input }),
  toolStatus: (input) => ({ type: "tool-status", ...input }),
  toolContent: (input) => ({ type: "tool-content", ...input }),
  toolOutput: (input) => ({ type: "tool-output", ...input }),
  toolError: (input) => ({ type: "tool-error", ...input }),
  fileDiff: (input) => ({ type: "file-diff", ...input }),
  stepStart: (input) => ({ type: "step-start", ...input }),
  inputIncorporated: (input) => ({ type: "input-incorporated", ...input }),
  permissionRequest: (input) => ({ type: "permission-request", ...input }),
  question: (input) => ({ type: "question", ...input }),
  questionAnswered: (input) => ({ type: "question-answered", ...input }),
  proposedPlanDelta: (input) => ({ type: "proposed-plan-delta", ...input }),
  proposedPlanComplete: (input) => ({ type: "proposed-plan-complete", ...input }),
  todoUpdate: (input) => ({ type: "todo-update", ...input }),
  sessionStatus: (input) => ({ type: "session-status", ...input }),
  sessionCompaction: (input) => ({ type: "session-compaction", ...input }),
  harnessNotice: (input) => ({ type: "harness-notice", ...input }),
  agentMessage: (input) => ({ type: "agent-message", ...input }),
  sessionRetry: (input) => ({ type: "session-retry", ...input }),
  responseStart: (input) => ({ type: "response-start", ...input }),
  responseRetracted: (input) => ({ type: "response-retracted", ...input }),
  conversationReset: (input) => ({ type: "conversation-reset", ...input }),
  authStatus: (input) => ({ type: "auth-status", ...input }),
  rateLimit: (input) => ({ type: "rate-limit", ...input }),
  mcpServerStatus: (input) => ({ type: "mcp-server-status", ...input }),
  goalUpdated: (input) => ({ type: "goal-updated", ...input }),
  goalCleared: (input) => ({ type: "goal-cleared", ...input }),
  subagentUpdated: (input) => ({ type: "subagent-updated", ...input }),
  finish: (input) => ({ type: "finish", ...input }),
  cancelled: (input) => ({ type: "cancelled", ...input }),
  error: (input) => ({ type: "error", ...input }),
  imageDelta: (input) => ({ type: "image-delta", ...input }),
  audioDelta: (input) => ({ type: "audio-delta", ...input }),
  resourceLinkDelta: (input) => ({ type: "resource-link-delta", ...input }),
  thinkingAudioDelta: (input) => ({ type: "thinking-audio-delta", ...input }),
  thinkingResourceLinkDelta: (input) => ({ type: "thinking-resource-link-delta", ...input }),
  resourceDelta: (input) => ({ type: "resource-delta", ...input }),
  toolLocation: (input) => ({ type: "tool-location", ...input }),
  toolTerminal: (input) => ({ type: "tool-terminal", ...input }),
  availableCommandsUpdate: (input) => ({ type: "available-commands-update", ...input }),
  sessionAgent: (input) => ({ type: "session-agent", ...input }),
  configUpdate: (input) => ({ type: "config-update", ...input }),
  sessionInfo: (input) => ({ type: "session-info", ...input }),
  sessionTitle: (input) => ({ type: "session-title", ...input }),
  backgroundWork: (input) => ({ type: "background-work", ...input }),
  usage: (input) => ({ type: "usage", ...input }),
  diagnostic: (input) => ({ type: "diagnostic", ...input }),
} satisfies AgentRuntimeEventFactoriesFor<AgentRuntimeEventFactoryTypes>
