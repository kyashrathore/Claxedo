import type { AvailableCommand, ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk"
import type { RuntimeQuestion } from "@claxedo/agent-runtime-contract"
import type { RuntimeDiagnostic } from "./diagnostics"
import type { RawHarnessEvent } from "./raw-harness-event"

export const AGENT_RUNTIME_EVENT_CONTRACT_VERSION = 7

export type RuntimeStatus = "busy" | "idle" | "error" | "recovering"
export type RuntimeToolStatus = "pending" | "running" | "completed" | "failed"
export type RuntimeNoticeSeverity = "debug" | "info" | "warn" | "error"
export const RUNTIME_GOAL_STATUSES = ["active", "paused", "blocked", "limited", "complete"] as const
export type RuntimeGoalStatus = typeof RUNTIME_GOAL_STATUSES[number]
export type RuntimeGoalSnapshot = {
  /** Claxedo session identity. One session owns at most one Goal. */
  sessionId: string
  objective: string
  status: RuntimeGoalStatus
  createdAt: number
  updatedAt: number
  /** Provider-reported fields. Absence means unknown and must remain absent. */
  tokenBudget?: number
  tokensUsed?: number
  timeUsedSeconds?: number
  iteration?: number
  lastReason?: string
}

export function isRuntimeGoalStatus(value: unknown): value is RuntimeGoalStatus {
  return typeof value === "string" && (RUNTIME_GOAL_STATUSES as readonly string[]).includes(value)
}

export type SubagentStatus = "pending" | "running" | "paused" | "interrupted" | "completed" | "failed" | "killed"
export type SubagentMode = "foreground" | "background"
export type SubagentToolCallRole = "spawn" | "interaction"
/**
 * The completion wake a host-owned child owes its parent: `pending` until the
 * runtime has started the parent turn that carries the child's summary.
 */
export type SubagentWake = "pending" | "delivered"
export type SubagentTranscript = {
  kind: "live" | "file" | "messages" | "none"
  ref?: string
}

/**
 * Provider-reported token categories for one turn observation.
 *
 * `null` means the provider did not report the category. This is deliberately
 * different from a reported zero: metering consumers must never manufacture a
 * measured zero for an unknown category.
 */
export type RuntimeTokenUsage = {
  input: number | null
  output: number | null
  reasoning: number | null
  cache: {
    read: number | null
    write: number | null
  }
}

export type RuntimeUsageObservation = {
  /** Whether this observation replaces prior turn usage or adds to it. */
  kind: "cumulative" | "delta"
  tokens: RuntimeTokenUsage
  /** Provider-native ordering data when the source exposes it. */
  sequence?: number
  providerObservationId?: string
  /** Provider-native session/thread identity used only for local overlap classification. */
  nativeSessionId?: string
  observedAt?: number
}

export type SubagentUpdatedEvent = {
  type: "subagent-updated"
  subagentKey: string
  revision: number
  toolCallId?: string
  toolCallRole?: SubagentToolCallRole
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  childSessionId?: string
  transcript?: SubagentTranscript
  /** Permission and question requests the child is holding open, to be answered by a human. */
  attention?: number
  wake?: SubagentWake
}

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

export type AcpContentBlock = ContentBlock
export type AcpAvailableCommand = AvailableCommand
export type AcpToolCallContent = ToolCallContent

type RuntimeEventMeta = {
  harness?: string
  threadId?: string
  raw?: RawHarnessEvent
  diagnostics?: RuntimeDiagnostic[]
}

/**
 * A tool result's image, carried by location when the workspace can serve it
 * and by value only when it cannot. `path` is workspace-relative because the
 * workspace file routes reject absolute paths outright.
 */
export type RuntimeToolAttachment = { mime: string; filename?: string } & (
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
  | { type: "user-message-delta"; messageId?: string; content: AcpContentBlock }
  | { type: "tool-start"; toolCallId: string; toolName: string; kind?: string; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-input"; toolCallId: string; input: unknown; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-status"; toolCallId: string; status: RuntimeToolStatus; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-content"; toolCallId: string; content: AcpToolCallContent; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-output"; toolCallId: string; output: unknown; attachments?: RuntimeToolAttachment[]; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-error"; toolCallId: string; error: string; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "file-diff"; toolCallId?: string; path: string; oldText?: string; newText: string }
  | { type: "step-start"; newMessageId: string }
  | { type: "permission-request"; requestId: string; tool: string; paths: string[]; details?: { command?: string; reason?: string } }
  | { type: "question"; requestId: string; questions: RuntimeQuestion[] }
  | { type: "question-answered"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "proposed-plan-delta"; delta: string }
  | { type: "proposed-plan-complete"; planMarkdown: string }
  | { type: "todo-update"; todos: Array<{ id: string; description: string; status: string; priority?: string }> }
  | { type: "session-status"; status: RuntimeStatus }
  | { type: "session-compaction"; phase: "started" | "completed"; reason?: string; summary?: string; metadata?: Record<string, unknown> }
  | { type: "harness-notice"; code: string; message: string; severity?: RuntimeNoticeSeverity; details?: unknown }
  | { type: "auth-status"; status: "authenticated" | "unauthenticated" | "unknown"; authMode?: string | null; planType?: string | null; metadata?: Record<string, unknown> }
  | { type: "rate-limit"; status: "ok" | "limited"; usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null; limitId?: string | null; limitName?: string | null; reason?: string | null; metadata?: Record<string, unknown> }
  | { type: "mcp-server-status"; serverName: string; status: "starting" | "ready" | "failed" | "cancelled"; error?: string | null }
  | { type: "goal-updated"; sessionId: string; goal: RuntimeGoalSnapshot }
  | { type: "goal-cleared"; sessionId: string }
  | SubagentUpdatedEvent
  | { type: "finish"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "image-delta"; mimeType: string; data: string }
  | { type: "audio-delta"; mimeType: string; data: string }
  | { type: "resource-link-delta"; uri: string; name: string; mimeType?: string; title?: string }
  | { type: "thinking-audio-delta"; mimeType: string; data: string }
  | { type: "thinking-resource-link-delta"; uri: string; name: string; mimeType?: string; title?: string }
  | { type: "resource-delta"; resource: unknown; channel: "assistant" | "thinking" }
  | { type: "tool-location"; toolCallId: string; locations: Array<{ path: string; line?: number }> }
  | { type: "tool-terminal"; toolCallId: string; terminalId: string }
  | { type: "available-commands-update"; commands: AcpAvailableCommand[] }
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
  | { type: "session-title"; title: string }
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
  "user-message-delta": true,
  "tool-start": true,
  "tool-input": true,
  "tool-status": true,
  "tool-content": true,
  "tool-output": true,
  "tool-error": true,
  "file-diff": true,
  "step-start": true,
  "permission-request": true,
  question: true,
  "question-answered": true,
  "proposed-plan-delta": true,
  "proposed-plan-complete": true,
  "todo-update": true,
  "session-status": true,
  "session-compaction": true,
  "harness-notice": true,
  "auth-status": true,
  "rate-limit": true,
  "mcp-server-status": true,
  "goal-updated": true,
  "goal-cleared": true,
  "subagent-updated": true,
  finish: true,
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
  userMessageDelta: "user-message-delta",
  toolStart: "tool-start",
  toolInput: "tool-input",
  toolStatus: "tool-status",
  toolContent: "tool-content",
  toolOutput: "tool-output",
  toolError: "tool-error",
  fileDiff: "file-diff",
  stepStart: "step-start",
  permissionRequest: "permission-request",
  question: "question",
  questionAnswered: "question-answered",
  proposedPlanDelta: "proposed-plan-delta",
  proposedPlanComplete: "proposed-plan-complete",
  todoUpdate: "todo-update",
  sessionStatus: "session-status",
  sessionCompaction: "session-compaction",
  harnessNotice: "harness-notice",
  authStatus: "auth-status",
  rateLimit: "rate-limit",
  mcpServerStatus: "mcp-server-status",
  goalUpdated: "goal-updated",
  goalCleared: "goal-cleared",
  subagentUpdated: "subagent-updated",
  finish: "finish",
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
  userMessageDelta: (input) => ({ type: "user-message-delta", ...input }),
  toolStart: (input) => ({ type: "tool-start", ...input }),
  toolInput: (input) => ({ type: "tool-input", ...input }),
  toolStatus: (input) => ({ type: "tool-status", ...input }),
  toolContent: (input) => ({ type: "tool-content", ...input }),
  toolOutput: (input) => ({ type: "tool-output", ...input }),
  toolError: (input) => ({ type: "tool-error", ...input }),
  fileDiff: (input) => ({ type: "file-diff", ...input }),
  stepStart: (input) => ({ type: "step-start", ...input }),
  permissionRequest: (input) => ({ type: "permission-request", ...input }),
  question: (input) => ({ type: "question", ...input }),
  questionAnswered: (input) => ({ type: "question-answered", ...input }),
  proposedPlanDelta: (input) => ({ type: "proposed-plan-delta", ...input }),
  proposedPlanComplete: (input) => ({ type: "proposed-plan-complete", ...input }),
  todoUpdate: (input) => ({ type: "todo-update", ...input }),
  sessionStatus: (input) => ({ type: "session-status", ...input }),
  sessionCompaction: (input) => ({ type: "session-compaction", ...input }),
  harnessNotice: (input) => ({ type: "harness-notice", ...input }),
  authStatus: (input) => ({ type: "auth-status", ...input }),
  rateLimit: (input) => ({ type: "rate-limit", ...input }),
  mcpServerStatus: (input) => ({ type: "mcp-server-status", ...input }),
  goalUpdated: (input) => ({ type: "goal-updated", ...input }),
  goalCleared: (input) => ({ type: "goal-cleared", ...input }),
  subagentUpdated: (input) => ({ type: "subagent-updated", ...input }),
  finish: (input) => ({ type: "finish", ...input }),
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
  usage: (input) => ({ type: "usage", ...input }),
  diagnostic: (input) => ({ type: "diagnostic", ...input }),
} satisfies AgentRuntimeEventFactoriesFor<AgentRuntimeEventFactoryTypes>
