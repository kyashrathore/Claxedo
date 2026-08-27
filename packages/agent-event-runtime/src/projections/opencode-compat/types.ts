import type { Event as OpenCodeSdkEvent, Part, SessionStatus } from "@opencode-ai/sdk/v2"
import type { RuntimeUsageObservation } from "../../contracts/agent-runtime-event"

export type OpenCodeCompatEnvelope<Event extends OpenCodeCompatEvent = OpenCodeCompatEvent> = {
  directory: string
  payload: Event
}

export type OpenCodeCompatRecoveringStatus = {
  type: "recovering"
  kind: "process_restart"
  message: string
}

export type OpenCodeCompatStatus = SessionStatus | OpenCodeCompatRecoveringStatus

type OpenCodeProjectionBaseSdkEvent = Extract<OpenCodeSdkEvent, {
  type:
    | "message.updated"
    | "message.part.updated"
    | "message.part.delta"
    | "permission.asked"
    | "permission.replied"
    | "question.asked"
    | "question.replied"
    | "question.rejected"
    | "todo.updated"
    | "session.status"
    | "session.idle"
    | "session.error"
    | "session.updated"
    | "session.diff"
    | "session.compacted"
    | "server.connected"
}>

type EventSessionStatusBase = Extract<OpenCodeProjectionBaseSdkEvent, { type: "session.status" }>
type EventMessagePartUpdatedBase = Extract<OpenCodeProjectionBaseSdkEvent, { type: "message.part.updated" }>

export type OpenCodeCompatHandoffPart = {
  id: string
  sessionID: string
  messageID: string
  type: "handoff"
  from: { id: string; access: string; connection?: unknown }
  to: { id: string; access: string; connection?: unknown }
}

export type OpenCodeCompatPart = Part | OpenCodeCompatHandoffPart

export type EventMessagePartUpdated = Omit<EventMessagePartUpdatedBase, "properties"> & {
  properties: Omit<EventMessagePartUpdatedBase["properties"], "part"> & {
    part: OpenCodeCompatPart
  }
}

export type EventSessionStatus = Omit<EventSessionStatusBase, "properties"> & {
  properties: Omit<EventSessionStatusBase["properties"], "status"> & {
    status: OpenCodeCompatStatus
  }
}

export type OpenCodeProjectionBaseEvent =
  | Exclude<OpenCodeProjectionBaseSdkEvent, { type: "session.status" | "message.part.updated" }>
  | EventSessionStatus
  | EventMessagePartUpdated

export type ClaxedoProjectionExtensionEvent =
  | EventMessageCompleted
  | EventSessionAgent
  | EventSessionConfig
  | EventSessionUsage
  | EventRuntimeDiagnostic

export type OpenCodeCompatEvent = OpenCodeProjectionBaseEvent | ClaxedoProjectionExtensionEvent

export type EventMessageUpdated = Extract<OpenCodeProjectionBaseEvent, { type: "message.updated" }>
export type EventMessagePartDelta = Extract<OpenCodeProjectionBaseEvent, { type: "message.part.delta" }>
export type EventPermissionAsked = Extract<OpenCodeProjectionBaseEvent, { type: "permission.asked" }>
export type EventPermissionReplied = Extract<OpenCodeProjectionBaseEvent, { type: "permission.replied" }>
export type EventQuestionAsked = Extract<OpenCodeProjectionBaseEvent, { type: "question.asked" }>
export type EventQuestionReplied = Extract<OpenCodeProjectionBaseEvent, { type: "question.replied" }>
export type EventQuestionRejected = Extract<OpenCodeProjectionBaseEvent, { type: "question.rejected" }>
export type EventTodoUpdated = Extract<OpenCodeProjectionBaseEvent, { type: "todo.updated" }>
export type EventSessionIdle = Extract<OpenCodeProjectionBaseEvent, { type: "session.idle" }>
export type EventSessionError = Extract<OpenCodeProjectionBaseEvent, { type: "session.error" }>
export type EventSessionUpdated = Extract<OpenCodeProjectionBaseEvent, { type: "session.updated" }>
export type EventSessionDiff = Extract<OpenCodeProjectionBaseEvent, { type: "session.diff" }>
export type EventSessionCompacted = Extract<OpenCodeProjectionBaseEvent, { type: "session.compacted" }>
export type EventServerConnected = Extract<OpenCodeProjectionBaseEvent, { type: "server.connected" }>

export type EventMessageCompleted = {
  type: "message.completed"
  properties: {
    sessionID: string
    messageID: string
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
    options: OpenCodeCompatConfigOption[]
  }
}

export type EventSessionUsage = {
  type: "session.usage"
  properties: {
    sessionID: string
    messageID?: string
    contextSize: number
    contextUsed: number
    observation?: RuntimeUsageObservation
    cost?: {
      amount: number
      currency: string
    }
  }
}

export type EventRuntimeDiagnostic = {
  id?: string
  type: "runtime.diagnostic"
  properties: {
    sessionID: string
    harness?: string
    threadId?: string
    projection?: "opencode-compat"
    phase?: "ingest" | "terminalize"
    code: string
    message: string
    severity: "debug" | "info" | "warn" | "error"
    eventType?: string
    issues?: string[]
    details?: unknown
    auth?: unknown
    rateLimit?: unknown
    mcp?: unknown
    diagnostic?: unknown
    raw?: unknown
  }
}

export type PermissionRequest = EventPermissionAsked["properties"]
export type QuestionRequest = EventQuestionAsked["properties"]
export type OpenCodeCompatTodo = EventTodoUpdated["properties"]["todos"][number]
export type OpenCodeCompatSnapshotFileDiff = EventSessionDiff["properties"]["diff"][number]

export type OpenCodeCompatSession = EventSessionUpdated["properties"]["info"]

export type OpenCodeCompatConfigOption = {
  id: string
  name: string
  category?: string
  type: "select" | "boolean"
  currentValue: string | boolean
  selectOptions?: Array<{
    id: string
    name: string
  }>
}

export type CompatEvent = OpenCodeCompatEvent
export type CompatEnvelope<Event extends OpenCodeCompatEvent = OpenCodeCompatEvent> = OpenCodeCompatEnvelope<Event>
export type CompatPart = OpenCodeCompatPart
