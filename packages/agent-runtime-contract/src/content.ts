import type { AgentMessageAuthor } from "./sessions"

export type AgentMessageError = {
  name: string
  data: Record<string, unknown> & { message?: string }
}

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

export type AgentFilePart = AgentPartBase<"file"> & {
  mime: string
  filename?: string
  url: string
  source?: Record<string, unknown> & { type: "file" | "symbol" | "resource" }
}

export type AgentToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; time: { start: number } }
  | { status: "completed"; input: Record<string, unknown>; output: string; title: string; metadata: Record<string, unknown>; time: { start: number; end: number; compacted?: number }; attachments?: AgentFilePart[] }
  | { status: "error"; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; time: { start: number; end: number } }

export type AgentToolPart = AgentPartBase<"tool"> & {
  callID: string
  tool: string
  state: AgentToolState
  metadata?: Record<string, unknown>
}

export type AgentContentPart =
  | AgentTextPart
  | AgentReasoningPart
  | AgentFilePart
  | AgentToolPart
  | (AgentPartBase<"subtask"> & { prompt: string; description: string; agent: string; model?: { providerID: string; modelID: string }; command?: string })
  | (AgentPartBase<"step-start"> & { snapshot?: string })
  | (AgentPartBase<"step-finish"> & { reason: string; snapshot?: string; cost: number; tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } } })
  | (AgentPartBase<"snapshot"> & { snapshot: string })
  | (AgentPartBase<"patch"> & { hash: string; files: string[] })
  | (AgentPartBase<"agent"> & { name: string; source?: { value: string; start: number; end: number } })
  | (AgentPartBase<"retry"> & { attempt: number; error: AgentMessageError; time: { created: number } })
  | (AgentPartBase<"compaction"> & { auto: boolean; overflow?: boolean; tail_start_id?: string })
  | (AgentPartBase<"handoff"> & { from: { id: string; access: string; connection?: unknown }; to: { id: string; access: string; connection?: unknown } })

export type AgentTodo = {
  content: string
  status: string
  priority: string
}

export type AgentPermission = {
  id: string
  sessionID: string
  tool?: string | { messageID: string; callID: string }
  title?: string
  permission?: string
  patterns?: string[]
  always?: string[]
  metadata?: Record<string, unknown>
  time?: { created?: number }
  harnessPayload?: unknown
}

export type AgentQuestion = {
  id: string
  sessionID: string
  questions?: unknown[]
  tool?: unknown
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
