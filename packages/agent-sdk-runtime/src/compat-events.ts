import type {
  AssistantMessage,
  EventMessageUpdated,
  EventPermissionReplied,
  EventQuestionRejected,
  EventServerConnected,
  EventSessionCompacted,
  EventSessionDiff,
  Message,
  Session,
  Todo,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type {
  EventMessageCompleted,
  EventMessagePartUpdated,
  EventMessagePartDelta,
  EventPermissionAsked,
  EventQuestionAsked,
  EventQuestionReplied,
  EventRuntimeDiagnostic,
  EventSessionAgent,
  EventSessionConfig,
  EventSessionError,
  EventSessionIdle,
  EventSessionStatus,
  EventSessionUpdated,
  EventSessionUsage,
  EventTodoUpdated,
  OpenCodeCompatEvent,
  OpenCodeCompatPart,
  PermissionRequest,
  QuestionRequest,
} from "@claxedo/agent-event-runtime/opencode-compat"
import type { StatusCompat } from "./status"
import { firstTurnErrorData } from "./first-turn-error"

export type CompatPart = OpenCodeCompatPart
export type CompatPromptFormat =
  | { type: "json_schema"; name?: string; schema?: unknown; strict?: boolean; provider_payload?: unknown }
  | { type: string; provider_payload?: unknown; [key: string]: unknown }

export type EventServerHeartbeat = {
  type: "server.heartbeat"
  properties: Record<string, never>
}

type SdkRuntimeOnlyEvent = EventServerHeartbeat

export type CompatEvent = OpenCodeCompatEvent | SdkRuntimeOnlyEvent

export type CompatEnvelope = {
  directory: string
  payload: CompatEvent
}

// These helpers are the package-level constructors for OpenCode-compatible
// events. Route/adapters should use them instead of hand-assembling shapes
// except when they are validating external harness payloads.
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
  "session.status",
  "session.idle",
  "session.error",
  "session.updated",
  "session.diff",
  "session.compacted",
  "session.agent",
  "session.config",
  "session.usage",
  "runtime.diagnostic",
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
  return row as CompatEvent
}

export function eventSessionId(event: CompatEvent): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID
    case "session.updated":
      return event.properties.info.id
    case "message.part.updated":
      return event.properties.sessionID ?? event.properties.part.sessionID
    case "message.part.delta":
      return event.properties.sessionID
    case "message.completed":
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
    case "todo.updated":
    case "session.status":
    case "session.diff":
    case "session.compacted":
    case "session.idle":
    case "session.agent":
    case "session.config":
    case "session.usage":
    case "runtime.diagnostic":
      return event.properties.sessionID
    case "session.error":
      return event.properties.sessionID
    default:
      return undefined
  }
}

export function isTerminalCompatEvent(event: CompatEvent): event is Extract<CompatEvent, { type: "session.idle" | "session.error" }> {
  return event.type === "session.idle" || event.type === "session.error"
}

export function buildUserMessage(input: {
  id: string
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  created?: number
  tools?: Record<string, boolean>
  format?: CompatPromptFormat
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
    ...(input.format ? { format: input.format as UserMessage["format"] } : {}),
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
    id: `message.updated:${info.id}`,
    type: "message.updated",
    properties: { sessionID: info.sessionID, info },
  }
}

export function buildUserPromptParts(sessionID: string, messageID: string, parts: unknown[]): CompatPart[] {
  return parts.map((part, index) => {
    const row = rec(part) ?? {}
    const id = typeof row.id === "string" ? row.id : `${messageID}-part-${index}`
    if (row.type === "text") {
      return { id, sessionID, messageID, type: "text", text: typeof row.text === "string" ? row.text : "" }
    }
    if (row.type === "agent") {
      return {
        id,
        sessionID,
        messageID,
        type: "agent",
        name: typeof row.name === "string" ? row.name : typeof row.agent === "string" ? row.agent : "agent",
      }
    }
    return { id, sessionID, messageID, type: "text", text: JSON.stringify(part), synthetic: true }
  }) as CompatPart[]
}

export function messagePartUpdated(part: CompatPart): EventMessagePartUpdated {
  return {
    id: `message.part.updated:${part.messageID}:${part.id}`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time: Date.now(),
    },
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
    id: `message.part.delta:${input.messageID}:${input.partID}`,
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
    id: `permission.asked:${properties.id}`,
    type: "permission.asked",
    properties,
  }
}

export function permissionReplied(sessionID: string, requestID: string, reply: "once" | "always" | "reject"): EventPermissionReplied {
  return {
    id: `permission.replied:${requestID}`,
    type: "permission.replied",
    properties: { sessionID, requestID, reply },
  }
}

export function questionAsked(properties: QuestionRequest): EventQuestionAsked {
  return {
    id: `question.asked:${properties.id}`,
    type: "question.asked",
    properties,
  }
}

export function questionReplied(sessionID: string, requestID: string, answers: Array<Array<string>>): EventQuestionReplied {
  return {
    id: `question.replied:${requestID}`,
    type: "question.replied",
    properties: { sessionID, requestID, answers },
  }
}

export function questionRejected(sessionID: string, requestID: string): EventQuestionRejected {
  return {
    id: `question.rejected:${requestID}`,
    type: "question.rejected",
    properties: { sessionID, requestID },
  }
}

export function todoUpdated(sessionID: string, todos: Array<Todo>): EventTodoUpdated {
  return {
    id: `todo.updated:${sessionID}`,
    type: "todo.updated",
    properties: { sessionID, todos },
  }
}

export function sessionStatus(sessionID: string, status: StatusCompat): EventSessionStatus {
  return {
    id: `session.status:${sessionID}`,
    type: "session.status",
    properties: { sessionID, status },
  }
}

export function sessionCompacted(sessionID: string): EventSessionCompacted {
  return {
    id: `session.compacted:${sessionID}`,
    type: "session.compacted",
    properties: { sessionID },
  }
}

export function sessionDiff(sessionID: string, diff: EventSessionDiff["properties"]["diff"]): EventSessionDiff {
  return {
    id: `session.diff:${sessionID}`,
    type: "session.diff",
    properties: { sessionID, diff },
  }
}

export function sessionIdle(sessionID: string): EventSessionIdle {
  return {
    id: `session.idle:${sessionID}`,
    type: "session.idle",
    properties: { sessionID },
  }
}

export function sessionError(message: string, sessionID?: string): EventSessionError {
  return {
    id: `session.error:${sessionID ?? "global"}`,
    type: "session.error",
    properties: {
      ...(sessionID ? { sessionID } : {}),
      error: {
        name: "UnknownError",
        data: firstTurnErrorData(message),
      },
    },
  }
}

export function sessionUpdated(info: Session): EventSessionUpdated {
  return {
    id: `session.updated:${info.id}`,
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

export function runtimeDiagnostic(properties: EventRuntimeDiagnostic["properties"]): EventRuntimeDiagnostic {
  return {
    type: "runtime.diagnostic",
    properties,
  }
}

export function serverConnected(): EventServerConnected {
  return {
    id: "server.connected",
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
