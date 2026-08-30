import type {
  AgentConfigOption,
  AgentContentPart,
  AgentEventEnvelope,
  AgentMessageAuthor,
  AgentPresentationEvent,
  AgentPresentationSession,
  AgentRuntimeStatus,
  AgentSnapshotFileDiff,
  AgentTodo,
} from "@claxedo/agent-runtime-contract"

/**
 * Transitional projection names. Their source of truth is the dependency-free
 * Claxedo contract; this projection contains no provider SDK aliases.
 */
export type OpenCodeCompatEnvelope<Event extends OpenCodeCompatEvent = OpenCodeCompatEvent> = AgentEventEnvelope<Event>
export type OpenCodeCompatRecoveringStatus = Extract<AgentRuntimeStatus, { type: "recovering" }>
export type OpenCodeCompatStatus = AgentRuntimeStatus
export type OpenCodeCompatPart = AgentContentPart
export type OpenCodeCompatEvent = Exclude<AgentPresentationEvent, { type: "server.heartbeat" }>

export type ClaxedoMessageAuthor = AgentMessageAuthor
export type ClaxedoMessageInfoExtension = { claxedo?: { author: ClaxedoMessageAuthor } }

export type EventMessageUpdated = Extract<OpenCodeCompatEvent, { type: "message.updated" }>
export type EventMessagePartUpdated = Extract<OpenCodeCompatEvent, { type: "message.part.updated" }>
export type EventMessagePartDelta = Extract<OpenCodeCompatEvent, { type: "message.part.delta" }>
export type EventMessageCompleted = Extract<OpenCodeCompatEvent, { type: "message.completed" }>
export type EventPermissionAsked = Extract<OpenCodeCompatEvent, { type: "permission.asked" }>
export type EventPermissionReplied = Extract<OpenCodeCompatEvent, { type: "permission.replied" }>
export type EventQuestionAsked = Extract<OpenCodeCompatEvent, { type: "question.asked" }>
export type EventQuestionReplied = Extract<OpenCodeCompatEvent, { type: "question.replied" }>
export type EventQuestionRejected = Extract<OpenCodeCompatEvent, { type: "question.rejected" }>
export type EventTodoUpdated = Extract<OpenCodeCompatEvent, { type: "todo.updated" }>
export type EventSessionStatus = Extract<OpenCodeCompatEvent, { type: "session.status" }>
export type EventSessionIdle = Extract<OpenCodeCompatEvent, { type: "session.idle" }>
export type EventSessionError = Extract<OpenCodeCompatEvent, { type: "session.error" }>
export type EventSessionUpdated = Extract<OpenCodeCompatEvent, { type: "session.updated" }>
export type EventSessionDiff = Extract<OpenCodeCompatEvent, { type: "session.diff" }>
export type EventSessionCompacted = Extract<OpenCodeCompatEvent, { type: "session.compacted" }>
export type EventSessionAgent = Extract<OpenCodeCompatEvent, { type: "session.agent" }>
export type EventSessionConfig = Extract<OpenCodeCompatEvent, { type: "session.config" }>
export type EventSessionUsage = Extract<OpenCodeCompatEvent, { type: "session.usage" }>
export type EventRuntimeDiagnostic = Extract<OpenCodeCompatEvent, { type: "runtime.diagnostic" }>
export type EventServerConnected = Extract<OpenCodeCompatEvent, { type: "server.connected" }>

export type PermissionRequest = EventPermissionAsked["properties"]
export type QuestionRequest = EventQuestionAsked["properties"]
export type OpenCodeCompatTodo = AgentTodo
export type OpenCodeCompatSnapshotFileDiff = AgentSnapshotFileDiff
export type OpenCodeCompatSession = AgentPresentationSession
export type OpenCodeCompatConfigOption = AgentConfigOption

export type CompatEvent = OpenCodeCompatEvent
export type CompatEnvelope<Event extends OpenCodeCompatEvent = OpenCodeCompatEvent> = AgentEventEnvelope<Event>
export type CompatPart = AgentContentPart
