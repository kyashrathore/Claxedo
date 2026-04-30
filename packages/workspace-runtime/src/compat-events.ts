import type {
  AssistantMessage,
  Event,
  EventMessagePartDelta,
  EventMessageUpdated,
  EventPermissionAsked,
  EventPermissionReplied,
  EventQuestionAsked,
  EventQuestionRejected,
  EventQuestionReplied,
  EventSessionError,
  EventSessionIdle,
  EventSessionUpdated,
  EventTodoUpdated,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  Todo,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type { StatusCompat } from "./types/status"

export type DiffPart = {
  id: string
  sessionID: string
  messageID: string
  type: "diff"
  path: string
  oldText?: string
  newText: string
}

export type ImagePart = {
  id: string
  sessionID: string
  messageID: string
  type: "image"
  mimeType: string
  data: string
}

export type AudioPart = {
  id: string
  sessionID: string
  messageID: string
  type: "audio"
  mimeType: string
  data: string
}

export type ResourceLinkPart = {
  id: string
  sessionID: string
  messageID: string
  type: "resource-link"
  uri: string
  name: string
  mimeType?: string
}

export type TerminalPart = {
  id: string
  sessionID: string
  messageID: string
  type: "terminal"
  ptyId: string
}

export type CompatPart = Part | DiffPart | ImagePart | AudioPart | ResourceLinkPart | TerminalPart

export type EventMessagePartUpdated = {
  type: "message.part.updated"
  properties: {
    part: CompatPart
  }
}

export type EventMessageCompleted = {
  type: "message.completed"
  properties: {
    sessionID: string
    messageID: string
  }
}

export type EventSessionTodo = {
  type: "session.todo"
  properties: {
    sessionID: string
    todos: Array<Todo>
  }
}

export type EventSessionAgent = {
  type: "session.agent"
  properties: {
    sessionID: string
    agentId: string
  }
}

export type EventSessionConfig = {
  type: "session.config"
  properties: {
    sessionID: string
    options: Array<{
      id: string
      name: string
      category?: string
      type: "select" | "boolean"
      currentValue: string | boolean
      selectOptions?: Array<{ id: string; name: string }>
    }>
  }
}

export type EventSessionUsage = {
  type: "session.usage"
  properties: {
    sessionID: string
    contextSize: number
    contextUsed: number
    cost?: { amount: number; currency: string }
  }
}

export type EventSessionStatus = {
  type: "session.status"
  properties: {
    sessionID: string
    status: StatusCompat
  }
}

export type EventServerConnected = {
  type: "server.connected"
  properties: Record<string, never>
}

export type EventServerHeartbeat = {
  type: "server.heartbeat"
  properties: Record<string, never>
}

type CanonicalEvent =
  | EventMessageUpdated
  | EventMessagePartUpdated
  | EventMessagePartDelta
  | EventPermissionAsked
  | EventPermissionReplied
  | EventQuestionAsked
  | EventQuestionReplied
  | EventQuestionRejected
  | EventSessionStatus
  | EventSessionIdle
  | EventSessionError
  | EventTodoUpdated
  | EventSessionUpdated

export type CompatEvent =
  | CanonicalEvent
  | EventMessageCompleted
  | EventSessionTodo
  | EventSessionAgent
  | EventSessionConfig
  | EventSessionUsage
  | EventServerConnected
  | EventServerHeartbeat

export type CompatEnvelope = {
  directory: string
  payload: CompatEvent
}

const kinds = new Set<CompatEvent["type"]>([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.completed",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "todo.updated",
  "session.todo",
  "session.status",
  "session.idle",
  "session.error",
  "session.updated",
  "session.agent",
  "session.config",
  "session.usage",
  "server.connected",
  "server.heartbeat",
])

function rec(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

export function withDir(directory: string, payload: CompatEvent): CompatEnvelope {
  return { directory, payload }
}

export function toCompatEvent(input: unknown): CompatEvent | null {
  const row = rec(input)
  if (!row) return null
  const type = row.type
  if (typeof type !== "string" || !kinds.has(type as CompatEvent["type"])) return null
  const properties = rec(row.properties)
  if (!properties) return null
  return { type: type as CompatEvent["type"], properties } as CompatEvent
}

export function eventSessionId(event: CompatEvent): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID
    case "session.updated":
      return event.properties.info.id
    case "message.part.updated":
      return event.properties.part.sessionID
    case "message.part.delta":
      return event.properties.sessionID
    case "message.completed":
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
    case "todo.updated":
    case "session.todo":
    case "session.status":
    case "session.idle":
    case "session.agent":
    case "session.config":
    case "session.usage":
      return event.properties.sessionID
    case "session.error":
      return event.properties.sessionID
    default:
      return undefined
  }
}

export function buildUserMessage(input: {
  id: string
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  created?: number
  tools?: Record<string, boolean>
  format?: UserMessage["format"]
  system?: string
  variant?: string
}): UserMessage {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.created ?? Date.now() },
    agent: input.agent,
    model: input.model,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.system ? { system: input.system } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
  }
}

export function buildAssistantMessage(input: {
  id: string
  sessionID: string
  parentID: string
  agent: string
  model: { providerID: string; modelID: string }
  directory: string
  created?: number
  completed?: number
  error?: AssistantMessage["error"]
  finish?: string
  variant?: string
}): AssistantMessage {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: {
      created: input.created ?? Date.now(),
      ...(input.completed ? { completed: input.completed } : {}),
    },
    parentID: input.parentID,
    modelID: input.model.modelID,
    providerID: input.model.providerID,
    mode: "auto",
    agent: input.agent,
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(input.error ? { error: input.error } : {}),
    ...(input.finish ? { finish: input.finish } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
  }
}

export function buildSession(input: {
  id: string
  directory: string
  title: string
  created?: number
  updated?: number
  projectID?: string
  workspaceID?: string
}): Session {
  const created = input.created ?? Date.now()
  const updated = input.updated ?? created
  return {
    id: input.id,
    slug: input.id,
    projectID: input.projectID ?? input.directory,
    ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}),
    directory: input.directory,
    title: input.title,
    version: "local",
    time: { created, updated },
  }
}

export function messageUpdated(info: Message): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: { sessionID: info.sessionID, info },
  }
}

export function messagePartUpdated(part: CompatPart): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: { part },
  }
}

export function messagePartDelta(input: {
  sessionID: string
  messageID: string
  partID: string
  field: string
  delta: string
}): EventMessagePartDelta {
  return {
    type: "message.part.delta",
    properties: input,
  }
}

export function messageCompleted(sessionID: string, messageID: string): EventMessageCompleted {
  return {
    type: "message.completed",
    properties: { sessionID, messageID },
  }
}

export function permissionAsked(properties: PermissionRequest): EventPermissionAsked {
  return {
    type: "permission.asked",
    properties,
  }
}

export function permissionReplied(sessionID: string, requestID: string, reply: "once" | "always" | "reject"): EventPermissionReplied {
  return {
    type: "permission.replied",
    properties: { sessionID, requestID, reply },
  }
}

export function questionAsked(properties: QuestionRequest): EventQuestionAsked {
  return {
    type: "question.asked",
    properties,
  }
}

export function questionReplied(sessionID: string, requestID: string, answers: Array<Array<string>>): EventQuestionReplied {
  return {
    type: "question.replied",
    properties: { sessionID, requestID, answers },
  }
}

export function questionRejected(sessionID: string, requestID: string): EventQuestionRejected {
  return {
    type: "question.rejected",
    properties: { sessionID, requestID },
  }
}

export function todoUpdated(sessionID: string, todos: Array<Todo>): EventTodoUpdated {
  return {
    type: "todo.updated",
    properties: { sessionID, todos },
  }
}

export function sessionTodo(sessionID: string, todos: Array<Todo>): EventSessionTodo {
  return {
    type: "session.todo",
    properties: { sessionID, todos },
  }
}

export function sessionStatus(sessionID: string, status: StatusCompat): EventSessionStatus {
  return {
    type: "session.status",
    properties: { sessionID, status },
  }
}

export function sessionIdle(sessionID: string): EventSessionIdle {
  return {
    type: "session.idle",
    properties: { sessionID },
  }
}

export function sessionError(message: string, sessionID?: string): EventSessionError {
  return {
    type: "session.error",
    properties: {
      ...(sessionID ? { sessionID } : {}),
      error: {
        name: "UnknownError",
        data: { message },
      },
    },
  }
}

export function sessionUpdated(info: Session): EventSessionUpdated {
  return {
    type: "session.updated",
    properties: { sessionID: info.id, info },
  }
}

export function sessionAgent(sessionID: string, agentId: string): EventSessionAgent {
  return {
    type: "session.agent",
    properties: { sessionID, agentId },
  }
}

export function sessionConfig(properties: EventSessionConfig["properties"]): EventSessionConfig {
  return {
    type: "session.config",
    properties,
  }
}

export function sessionUsage(properties: EventSessionUsage["properties"]): EventSessionUsage {
  return {
    type: "session.usage",
    properties,
  }
}

export function serverConnected(): EventServerConnected {
  return {
    type: "server.connected",
    properties: {},
  }
}

export function serverHeartbeat(): EventServerHeartbeat {
  return {
    type: "server.heartbeat",
    properties: {},
  }
}
