import type { AvailableCommand, ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk"
import type { RuntimeDiagnostic } from "./diagnostics"
import type { RawHarnessEvent } from "./raw-harness-event"

export const AGENT_RUNTIME_EVENT_CONTRACT_VERSION = 3

export type RuntimeStatus = "busy" | "idle" | "error" | "recovering"
export type RuntimeToolStatus = "pending" | "running" | "completed" | "failed"
export type RuntimeNoticeSeverity = "debug" | "info" | "warn" | "error"

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
  | { type: "tool-output"; toolCallId: string; output: unknown; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "tool-error"; toolCallId: string; error: string; display?: ToolDisplay; metadata?: Record<string, unknown> }
  | { type: "file-diff"; toolCallId?: string; path: string; oldText?: string; newText: string }
  | { type: "step-start"; newMessageId: string }
  | { type: "permission-request"; requestId: string; tool: string; paths: string[] }
  | { type: "question"; requestId: string; questions: Array<{ text: string; options?: string[] }> }
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
  | { type: "subagent-spawned"; childSessionId: string }
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
  | { type: "session-info"; title?: string | null; updatedAt?: string | null }
  | { type: "session-title"; title: string }
  | { type: "usage"; contextSize: number; contextUsed: number; cost?: { amount: number; currency: string } }
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
  "subagent-spawned": true,
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

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
export const AGENT_RUNTIME_EVENT_TYPES = Object.keys(AGENT_RUNTIME_EVENT_TYPE_REGISTRY) as AgentRuntimeEventType[]

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
  subagentSpawned: "subagent-spawned",
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

function event<T extends AgentRuntimeEventType>(
  type: T,
  input: AgentRuntimeEventInput<T>,
): AgentRuntimeEventOf<T> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return { type, ...input } as AgentRuntimeEventOf<T>
}

function createAgentRuntimeEventFactories<Types extends Record<string, AgentRuntimeEventType>>(types: Types) {
  return (Object.fromEntries(
    Object.entries(types).map(([name, type]) => [
      name,
      (input: AgentRuntimeEventInput<AgentRuntimeEventType>) => event(type, input),
    ]),
  ) as unknown) as AgentRuntimeEventFactoriesFor<Types>
}

export const agentRuntimeEvent = createAgentRuntimeEventFactories(AGENT_RUNTIME_EVENT_FACTORY_TYPES)
