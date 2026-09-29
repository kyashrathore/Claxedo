import type { AgentContentPart, AgentMessageInfo, AgentPermission, AgentPermissionReply, AgentQuestion, AgentTodo } from "./content"
import type { AgentMessageAuthor, AgentPresentationSession, AgentSession, AgentSessionTitleSource, PromptFormat, PromptInput } from "./sessions"
import type { AgentRuntimeStatus } from "./availability"
import type { AgentPresentationEvent, AgentEventEnvelope } from "./events"
import { promptPartId } from "./content"
import type { FirstTurnErrorClass } from "./turn-error-classes"
import type { TurnAccount } from "./turn-account"
import { asRecord } from "./values"
import { firstTurnErrorData } from "./first-turn-error"
import { withClaxedoMessageAuthor } from "./message-author"

type EventMessageUpdated = Extract<AgentPresentationEvent, { type: "message.updated" }>
type EventMessageCompleted = Extract<AgentPresentationEvent, { type: "message.completed" }>
type EventMessagePartUpdated = Extract<AgentPresentationEvent, { type: "message.part.updated" }>
type EventMessagePartDelta = Extract<AgentPresentationEvent, { type: "message.part.delta" }>
type EventPermissionAsked = Extract<AgentPresentationEvent, { type: "permission.asked" }>
type EventPermissionReplied = Extract<AgentPresentationEvent, { type: "permission.replied" }>
type EventQuestionAsked = Extract<AgentPresentationEvent, { type: "question.asked" }>
type EventQuestionRejected = Extract<AgentPresentationEvent, { type: "question.rejected" }>
type EventSessionError = Extract<AgentPresentationEvent, { type: "session.error" }>
type EventSessionIdle = Extract<AgentPresentationEvent, { type: "session.idle" }>
type EventSessionStatus = Extract<AgentPresentationEvent, { type: "session.status" }>
type EventSessionUpdated = Extract<AgentPresentationEvent, { type: "session.updated" }>
type EventSessionUsage = Extract<AgentPresentationEvent, { type: "session.usage" }>
type EventTodoUpdated = Extract<AgentPresentationEvent, { type: "todo.updated" }>
type EventSessionDeleted = Extract<AgentPresentationEvent, { type: "session.deleted" }>
type EventHarnessHealth = Extract<AgentPresentationEvent, { type: "harness.health" }>

export function sessionDeleted(id: string, directory: string, parentID?: string): EventSessionDeleted {
  return { type: "session.deleted", properties: { info: { id, directory, ...(parentID ? { parentID } : {}) } } }
}

export function harnessHealthChanged(properties: EventHarnessHealth["properties"]): EventHarnessHealth {
  return { type: "harness.health", properties }
}

/**
 * The presentation frames a transport's stream may carry as-is: the
 * runtime commits one of these to the session's event log and publishes it
 * on the hub's global channel, and projects everything else as a raw
 * `AgentRuntimeEvent`. Deliberately a subset of `AgentPresentationEvent["type"]`:
 * `subagent.updated` and `goal.*` exist on the wire only as the projection
 * of their `subagent-updated` / `goal-*` runtime events, so admitting the
 * dot form here would publish a second copy outside the runtime channel;
 * `session.deleted` is published by the session routes straight to the
 * global channel; `message.removed` and `message.part.removed` have no
 * producer in this runtime.
 */
const kinds: ReadonlySet<string> = new Set<AgentPresentationEvent["type"]>([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.completed",
  "permission.asked",
  "permission.replied",
  "permission.expired",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.expired",
  "todo.updated",
  "session.status",
  "session.idle",
  "session.error",
  "session.updated",
  "session.diff",
  "session.compacted",
  "session.agent",
  "session.config",
  "session.commands",
  "session.usage",
  "runtime.diagnostic",
  "server.connected",
  "server.heartbeat",
])

export function withDir(directory: string, payload: AgentPresentationEvent): AgentEventEnvelope {
  return { directory, payload }
}

/** An unknown frame is a transport presentation frame when it names one of `kinds` and carries a properties object. */
function isTransportPresentationEvent(value: unknown): value is AgentPresentationEvent {
  const row = asRecord(value)
  return !!row && typeof row.type === "string" && kinds.has(row.type) && !!asRecord(row.properties)
}

export function toPresentationEvent(input: unknown): AgentPresentationEvent | null {
  return isTransportPresentationEvent(input) ? input : null
}

export function eventSessionId(event: AgentPresentationEvent): string | undefined {
  // Global stream frames may be partial. A frame without a valid session
  // identity is ignored without terminating the shared stream.
  const properties = (event.properties ?? {}) as {
    info?: { id?: string; sessionID?: string }
    part?: { sessionID?: string }
    sessionID?: string
  }
  switch (event.type) {
    case "message.updated":
      return properties.info?.sessionID ?? properties.sessionID
    case "session.updated":
    case "session.deleted":
      return properties.info?.id ?? properties.sessionID
    default:
      // Every other kind names its session on `properties` (a part frame on
      // the part too). The stream delivers a session-less frame to every
      // admitted principal, so a kind this does not name is still read for
      // one rather than shipped workspace-wide by omission.
      return properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID
  }
}

function isTerminalPresentationEvent(event: AgentPresentationEvent): event is Extract<AgentPresentationEvent, { type: "session.idle" | "session.error" }> {
  return event.type === "session.idle" || event.type === "session.error"
}

/**
 * Frames a stream must not shed and its replay buffer keeps in reserve:
 * each settles a state machine the client renders and nothing re-states it
 * before the turn ends — a lost one pins a turn to busy, a subagent to
 * running, or a tool row to "Running" with its clock still ticking. A tool's
 * start and input snapshots are chatty and stay evictable. Distinct from
 * `isTerminalPresentationEvent`, which is a transport's "the prompt is over".
 */
export function isRetainedPresentationEvent(event: AgentPresentationEvent): boolean {
  if (isTerminalPresentationEvent(event)) return true
  if (event.type === "message.part.updated") {
    const part = event.properties.part
    return part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")
  }
  if (event.type === "subagent.updated") {
    const status = event.properties.update.status
    return status === "completed" || status === "failed" || status === "killed" || status === "interrupted"
  }
  return false
}

export function buildUserMessage(input: {
  id: string
  sessionID: string
  agent: string
  model?: { providerID: string; modelID: string }
  created?: number
  tools?: Record<string, boolean>
  format?: PromptFormat
  system?: string
  variant?: string
  author?: AgentMessageAuthor
}): AgentMessageInfo {
  return withClaxedoMessageAuthor({
    id: input.id,
    sessionID: input.sessionID,
    role: "user",
    time: { created: input.created ?? Date.now() },
    agent: input.agent,
    ...(input.model ? { model: input.model } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.system ? { system: input.system } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
  }, input.author)
}

export function buildAssistantMessage(input: {
  id: string
  sessionID: string
  parentID: string
  agent: string
  model?: { providerID: string; modelID: string }
  directory: string
  created?: number
  completed?: number
  error?: AgentMessageInfo["error"]
  finish?: string
  variant?: string
}): AgentMessageInfo {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: {
      created: input.created ?? Date.now(),
      ...(input.completed ? { completed: input.completed } : {}),
    },
    parentID: input.parentID,
    ...(input.model ? { modelID: input.model.modelID, providerID: input.model.providerID } : {}),
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
  titleSource?: AgentSessionTitleSource
  created: number
  updated: number
  projectID?: string
  workspaceID?: string
}): AgentPresentationSession {
  return {
    id: input.id,
    slug: input.id,
    projectID: input.projectID ?? input.directory,
    ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}),
    directory: input.directory,
    title: input.title,
    ...(input.titleSource ? { titleSource: input.titleSource } : {}),
    version: "local",
    time: { created: input.created, updated: input.updated },
  }
}

export function messageUpdated(info: EventMessageUpdated["properties"]["info"]): EventMessageUpdated {
  return {
    id: `message.updated:${info.id}`,
    type: "message.updated",
    properties: { sessionID: info.sessionID, info },
  }
}

export function buildUserPromptParts(sessionID: string, messageID: string, parts: PromptInput["parts"]): AgentContentPart[] {
  return parts.map((part, index): AgentContentPart => ({
    ...part,
    id: promptPartId(messageID, index),
    sessionID,
    messageID,
  }))
}

export function messagePartUpdated(part: AgentContentPart): EventMessagePartUpdated {
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

export function permissionAsked(properties: AgentPermission): EventPermissionAsked {
  return {
    id: `permission.asked:${properties.id}`,
    type: "permission.asked",
    properties,
  }
}

export function permissionReplied(sessionID: string, requestID: string, reply: AgentPermissionReply): EventPermissionReplied {
  return {
    id: `permission.replied:${requestID}`,
    type: "permission.replied",
    properties: { sessionID, requestID, ...(typeof reply === "string" ? { reply } : reply) },
  }
}

export function questionAsked(properties: AgentQuestion): EventQuestionAsked {
  return {
    id: `question.asked:${properties.id}`,
    type: "question.asked",
    properties,
  }
}

export function questionRejected(sessionID: string, requestID: string): EventQuestionRejected {
  return {
    id: `question.rejected:${requestID}`,
    type: "question.rejected",
    properties: { sessionID, requestID },
  }
}

export function todoUpdated(sessionID: string, todos: Array<AgentTodo>): EventTodoUpdated {
  return {
    id: `todo.updated:${sessionID}`,
    type: "todo.updated",
    properties: { sessionID, todos },
  }
}

export function sessionStatus(sessionID: string, status: AgentRuntimeStatus): EventSessionStatus {
  return {
    id: `session.status:${sessionID}`,
    type: "session.status",
    properties: { sessionID, status },
  }
}

export function sessionIdle(sessionID: string): EventSessionIdle {
  return {
    id: `session.idle:${sessionID}`,
    type: "session.idle",
    properties: { sessionID },
  }
}

export function sessionError(
  message: string,
  sessionID?: string,
  facts: { errorClass?: FirstTurnErrorClass; account?: TurnAccount } = {},
): EventSessionError {
  return {
    id: `session.error:${sessionID ?? "global"}`,
    type: "session.error",
    properties: {
      ...(sessionID ? { sessionID } : {}),
      error: {
        name: "UnknownError",
        data: firstTurnErrorData(message, facts),
      },
    },
  }
}

export function sessionUpdated(info: AgentSession): EventSessionUpdated {
  return {
    id: `session.updated:${info.id}`,
    type: "session.updated",
    properties: { sessionID: info.id, info },
  }
}

export function sessionUsage(properties: EventSessionUsage["properties"]): EventSessionUsage {
  return {
    type: "session.usage",
    properties,
  }
}

