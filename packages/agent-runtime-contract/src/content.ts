import type { AgentMessageAuthor } from "./sessions"

export type AgentMessageError = {
  name: string
  data: Record<string, unknown> & { message?: string }
}

export type AgentOutputFormat =
  { type: "text" } | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number }

export type AgentUserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  format?: AgentOutputFormat
  summary?: {
    title?: string
    body?: string
    diffs: AgentSnapshotFileDiff[]
  }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  system?: string
  tools?: Record<string, boolean>
  claxedo?: { author: AgentMessageAuthor }
}

export type AgentAssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: AgentMessageError
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  structured?: unknown
  variant?: string
  finish?: string
}

/** Message information rendered by transcript and navigation surfaces. */
export type AgentPresentationMessage = AgentUserMessage | AgentAssistantMessage

export type AgentMessageInfo = {
  id: string
  role: string
  sessionID: string
  parentID?: string
  time?: { created: number; completed?: number }
  providerID?: string
  modelID?: string
  model?: { providerID: string; modelID: string; variant?: string }
  agent?: string
  mode?: string
  path?: { cwd: string; root: string }
  cost?: number
  tokens?: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  tools?: Record<string, boolean>
  system?: string
  variant?: string
  format?: unknown
  finish?: string
  error?: AgentMessageError
  claxedo?: { author: AgentMessageAuthor }
  harnessPayload?: unknown
  [key: string]: unknown
}

export type AgentMessage = {
  info: AgentMessageInfo
  parts: AgentContentPart[]
  harnessPayload?: unknown
}

type AgentPartBase<Type extends string> = {
  id: string
  sessionID: string
  messageID: string
  type: Type
}

export type AgentTextPart = AgentPartBase<"text"> & {
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export type AgentReasoningPart = AgentPartBase<"reasoning"> & {
  text: string
  time: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export type AgentFilePartSourceText = {
  value: string
  start: number
  end: number
}

export type AgentFilePartRange = {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export type AgentFileSource = {
  type: "file"
  text: AgentFilePartSourceText
  path: string
}

export type AgentSymbolSource = {
  type: "symbol"
  text: AgentFilePartSourceText
  path: string
  range: AgentFilePartRange
  name: string
  kind: number
}

export type AgentResourceSource = {
  type: "resource"
  text: AgentFilePartSourceText
  clientName: string
  uri: string
}

export type AgentFilePartSource = AgentFileSource | AgentSymbolSource | AgentResourceSource

export type AgentFilePart = AgentPartBase<"file"> & {
  mime: string
  filename?: string
  url: string
  source?: AgentFilePartSource
}

export type AgentTextPartInput = Omit<AgentTextPart, "id" | "sessionID" | "messageID"> & { id?: string }
export type AgentFilePartInput = Omit<AgentFilePart, "id" | "sessionID" | "messageID"> & { id?: string }
export type AgentAgentPartInput = Omit<AgentAgentPart, "id" | "sessionID" | "messageID"> & { id?: string }

export type AgentToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number; compacted?: number }
      attachments?: AgentFilePart[]
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }

export type AgentToolPart = AgentPartBase<"tool"> & {
  callID: string
  tool: string
  state: AgentToolState
  metadata?: Record<string, unknown>
}

export type AgentSubtaskPart = AgentPartBase<"subtask"> & {
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}

export type AgentStepStartPart = AgentPartBase<"step-start"> & { snapshot?: string }

export type AgentStepFinishPart = AgentPartBase<"step-finish"> & {
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type AgentSnapshotPart = AgentPartBase<"snapshot"> & { snapshot: string }
export type AgentPatchPart = AgentPartBase<"patch"> & { hash: string; files: string[] }
export type AgentAgentPart = AgentPartBase<"agent"> & {
  name: string
  source?: { value: string; start: number; end: number }
}
export type AgentRetryPart = AgentPartBase<"retry"> & {
  attempt: number
  error: AgentMessageError
  time: { created: number }
}
export type AgentCompactionPart = AgentPartBase<"compaction"> & {
  auto: boolean
  overflow?: boolean
  tail_start_id?: string
}
export type AgentHandoffPart = AgentPartBase<"handoff"> & {
  from: { id: string; access: string; connection?: unknown }
  to: { id: string; access: string; connection?: unknown }
}

export type AgentContentPart =
  | AgentTextPart
  | AgentReasoningPart
  | AgentFilePart
  | AgentToolPart
  | AgentSubtaskPart
  | AgentStepStartPart
  | AgentStepFinishPart
  | AgentSnapshotPart
  | AgentPatchPart
  | AgentAgentPart
  | AgentRetryPart
  | AgentCompactionPart
  | AgentHandoffPart

export type AgentPromptResponse = {
  info: AgentAssistantMessage
  parts: AgentContentPart[]
}

export type AgentTodo = {
  content: string
  status: string
  priority: string
}

export type AgentQuestionOption = {
  label: string
  description: string
}

export type AgentQuestionInfo = {
  question: string
  header: string
  options: AgentQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type AgentQuestionAnswer = string[]

export type AgentPermission = {
  id: string
  sessionID: string
  tool?: { messageID: string; callID: string }
  title?: string
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
  time?: { created?: number }
  harnessPayload?: unknown
}

export type AgentQuestion = {
  id: string
  sessionID: string
  questions: AgentQuestionInfo[]
  tool?: { messageID: string; callID: string }
  harnessPayload?: unknown
}

export type AgentCommand = { name: string; content?: string; description?: string; harnessPayload?: unknown }
export type AgentAgent = { name: string; description?: string; mode?: string; harnessPayload?: unknown }
export type AgentConfigOption = {
  id: string
  name?: string
  type?: string
  category?: string
  currentValue?: unknown
  description?: string
  selectOptions?: Array<{ id: string; name?: string; description?: string; value?: unknown; harnessPayload?: unknown }>
  harnessPayload?: unknown
}

export type AgentSnapshotFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
