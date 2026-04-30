import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { CompatEvent } from "../compat-events"
import type { StatusChunk } from "../types/status"

export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "thinking-delta"; delta: string }
  | { type: "tool-start"; toolCallId: string; toolName: string; kind?: string; metadata?: Record<string, unknown> }
  | { type: "tool-input"; toolCallId: string; input: unknown; metadata?: Record<string, unknown> }
  | { type: "tool-output"; toolCallId: string; output: unknown; metadata?: Record<string, unknown> }
  | { type: "tool-error"; toolCallId: string; error: string; metadata?: Record<string, unknown> }
  | { type: "file-diff"; toolCallId?: string; path: string; oldText?: string; newText: string }
  | { type: "step-start"; newMessageId: string }
  | { type: "permission-request"; requestId: string; tool: string; paths: string[] }
  | { type: "question"; requestId: string; questions: Array<{ text: string; options?: string[] }> }
  | { type: "todo-update"; todos: Array<{ id: string; description: string; status: string; priority?: string }> }
  | { type: "session-status"; status: StatusChunk }
  | { type: "subagent-spawned"; childSessionId: string }
  | { type: "finish"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "image-delta"; mimeType: string; data: string }
  | { type: "audio-delta"; mimeType: string; data: string }
  | { type: "resource-link-delta"; uri: string; name: string; mimeType?: string; title?: string }
  | { type: "tool-location"; toolCallId: string; locations: Array<{ path: string; line?: number }> }
  | { type: "tool-terminal"; toolCallId: string; terminalId: string }
  | { type: "session-agent"; agentId: string }
  | { type: "config-update"; options: Array<{ id: string; name: string; category?: string; type: "select" | "boolean"; currentValue: string | boolean; selectOptions?: Array<{ id: string; name: string }> }> }
  | { type: "session-title"; title: string }
  | { type: "usage"; contextSize: number; contextUsed: number; cost?: { amount: number; currency: string } }

export type UIMessageChunk = AgentEvent

export interface AgentBackendPlugin<Native = unknown, State = unknown> extends AgentAdapter {
  translateNativeEvent(event: Native, state: State): AgentEvent[]
}

export type PromptModel = {
  providerID: string
  modelID: string
}

export type PromptInput = {
  parts: unknown[]
  userMessageId?: string
  assistantMessageId: string
  agent: string
  model: PromptModel
  tools?: Record<string, boolean>
  format?: UserMessage["format"]
  system?: string
  variant?: string
}

export type SessionRunner = {
  type: "claude-acp" | "codex-acp" | "cursor-acp" | "opencode" | "pi"
  binary?: string
  model?: string
}

export type SessionConfig = {
  runner: SessionRunner
  model?: PromptModel
  variant?: string | null
  agent?: string | null
}

export type SessionConfigPatch = {
  runner?: SessionRunner
  model?: PromptModel | null
  variant?: string | null
  agent?: string | null
}

export type AbortResult =
  | { ok: true; status: "cancelled" | "already_idle" }
  | { ok: false; status: "not_found" | "recovering" | "failed"; message: string }

export interface AgentAdapter {
  // Session lifecycle
  listSessions(directory: string): Promise<unknown[]>
  getSession(id: string, directory: string): Promise<unknown | null>
  createSession(directory: string, title?: string): Promise<{ id: string }>
  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: string): Promise<unknown | null>
  getSessionConfig(id: string, directory: string): Promise<SessionConfig>
  updateSessionConfig(id: string, patch: SessionConfigPatch, directory: string): Promise<SessionConfig>
  deleteSession(id: string, directory: string): Promise<void>

  // Messaging
  sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<CompatEvent>
  getMessages(id: string, directory: string): Promise<unknown[]>
  abort(id: string, directory: string): Promise<AbortResult>
  revert(id: string, directory: string): Promise<void>
  unrevert(id: string, directory: string): Promise<void>
  forkSession(id: string, messageId: string, directory: string): Promise<{ id: string }>

  // Slash commands
  executeCommand(id: string, command: string, directory: string): Promise<void>
  listCommands(directory: string): Promise<unknown[]>

  // Agents
  listAgents(directory: string): Promise<unknown[]>

  // Todos (plan state)
  getTodos(sessionId: string, directory: string): Promise<Array<{ content: string; status: string; priority: string }>>

  // Permission dock
  listPermissions(directory: string): Promise<unknown[]>
  respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): Promise<void>
  // Question dock
  listQuestions(directory: string): Promise<unknown[]>
  replyQuestion(qId: string, answer: string, directory: string): Promise<void>
  rejectQuestion(qId: string, directory: string): Promise<void>

  // Config injection from claxedo-server
  applyConfig(config: Record<string, unknown>): Promise<void>

  // ACP config options (model list, modes, etc.) — no-op for non-ACP adapters
  probeConfigOptions(directory: string): Promise<unknown[]>
  peekConfigOptions?(directory: string): Promise<unknown[] | null> | unknown[] | null

  dispose(): void
}
