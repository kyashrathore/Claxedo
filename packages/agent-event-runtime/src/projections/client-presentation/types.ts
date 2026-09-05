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

/** Claxedo-owned client-presentation contract; it contains no provider SDK aliases. */
export type ClientPresentationStatus = AgentRuntimeStatus
export type ClientPresentationPart = AgentContentPart
export type ClientPresentationEvent = Exclude<AgentPresentationEvent, { type: "server.heartbeat" }>

export type ClaxedoMessageAuthor = AgentMessageAuthor
export type ClaxedoMessageInfoExtension = { claxedo?: { author: ClaxedoMessageAuthor } }

export type EventMessageUpdated = Extract<ClientPresentationEvent, { type: "message.updated" }>
export type EventMessagePartUpdated = Extract<ClientPresentationEvent, { type: "message.part.updated" }>
export type EventMessagePartDelta = Extract<ClientPresentationEvent, { type: "message.part.delta" }>
export type EventMessageCompleted = Extract<ClientPresentationEvent, { type: "message.completed" }>
export type EventPermissionAsked = Extract<ClientPresentationEvent, { type: "permission.asked" }>
export type EventPermissionReplied = Extract<ClientPresentationEvent, { type: "permission.replied" }>
export type EventQuestionAsked = Extract<ClientPresentationEvent, { type: "question.asked" }>
export type EventQuestionReplied = Extract<ClientPresentationEvent, { type: "question.replied" }>
export type EventQuestionRejected = Extract<ClientPresentationEvent, { type: "question.rejected" }>
export type EventTodoUpdated = Extract<ClientPresentationEvent, { type: "todo.updated" }>
export type EventSessionStatus = Extract<ClientPresentationEvent, { type: "session.status" }>
export type EventSessionIdle = Extract<ClientPresentationEvent, { type: "session.idle" }>
export type EventSessionError = Extract<ClientPresentationEvent, { type: "session.error" }>
export type EventSessionUpdated = Extract<ClientPresentationEvent, { type: "session.updated" }>
export type EventSessionDiff = Extract<ClientPresentationEvent, { type: "session.diff" }>
export type EventSessionCompacted = Extract<ClientPresentationEvent, { type: "session.compacted" }>
export type EventSessionAgent = Extract<ClientPresentationEvent, { type: "session.agent" }>
export type EventSessionConfig = Extract<ClientPresentationEvent, { type: "session.config" }>
export type EventSessionUsage = Extract<ClientPresentationEvent, { type: "session.usage" }>
export type EventRuntimeDiagnostic = Extract<ClientPresentationEvent, { type: "runtime.diagnostic" }>
export type EventServerConnected = Extract<ClientPresentationEvent, { type: "server.connected" }>

export type PermissionRequest = EventPermissionAsked["properties"]
export type QuestionRequest = EventQuestionAsked["properties"]
export type ClientPresentationTodo = AgentTodo
export type ClientPresentationSnapshotFileDiff = AgentSnapshotFileDiff
export type ClientPresentationSession = AgentPresentationSession
export type ClientPresentationConfigOption = AgentConfigOption

export type CompatEvent = ClientPresentationEvent
export type CompatEnvelope<Event extends ClientPresentationEvent = ClientPresentationEvent> = AgentEventEnvelope<Event>
export type CompatPart = AgentContentPart
