import type {
  AgentContentPart,
  AgentMessageAuthor,
  AgentMessageInfo,
  AgentPermission,
  AgentPresentationEvent,
  PromptInput,
  AgentQuestion,
  AgentPresentationSession,
  AgentSessionTitleSource,
  AgentSession,
  AgentTodo,
} from "@claxedo/agent-runtime-contract"
import { parseAgentContentPart } from "@claxedo/agent-runtime-contract"
import { withClaxedoMessageAuthor } from "@claxedo/agent-event-runtime/client-presentation"
import { asRecord } from "@claxedo/helpers/guards"
import type { StatusCompat } from "./status"
import { firstTurnErrorData } from "./first-turn-error"

type EventMessageUpdated = Extract<AgentPresentationEvent, { type: "message.updated" }>
type EventMessageCompleted = Extract<AgentPresentationEvent, { type: "message.completed" }>
type EventMessagePartUpdated = Extract<AgentPresentationEvent, { type: "message.part.updated" }>
type EventMessagePartDelta = Extract<AgentPresentationEvent, { type: "message.part.delta" }>
type EventPermissionAsked = Extract<AgentPresentationEvent, { type: "permission.asked" }>
type EventPermissionReplied = Extract<AgentPresentationEvent, { type: "permission.replied" }>
type EventQuestionAsked = Extract<AgentPresentationEvent, { type: "question.asked" }>
type EventQuestionReplied = Extract<AgentPresentationEvent, { type: "question.replied" }>
type EventQuestionRejected = Extract<AgentPresentationEvent, { type: "question.rejected" }>
type EventRuntimeDiagnostic = Extract<AgentPresentationEvent, { type: "runtime.diagnostic" }>
type EventSessionAgent = Extract<AgentPresentationEvent, { type: "session.agent" }>
type EventSessionCompacted = Extract<AgentPresentationEvent, { type: "session.compacted" }>
type EventSessionConfig = Extract<AgentPresentationEvent, { type: "session.config" }>
type EventSessionDiff = Extract<AgentPresentationEvent, { type: "session.diff" }>
type EventSessionError = Extract<AgentPresentationEvent, { type: "session.error" }>
type EventSessionIdle = Extract<AgentPresentationEvent, { type: "session.idle" }>
type EventSessionStatus = Extract<AgentPresentationEvent, { type: "session.status" }>
type EventSessionUpdated = Extract<AgentPresentationEvent, { type: "session.updated" }>
type EventSessionUsage = Extract<AgentPresentationEvent, { type: "session.usage" }>
type EventTodoUpdated = Extract<AgentPresentationEvent, { type: "todo.updated" }>

export type CompatPart = AgentContentPart
export type CompatPromptFormat =
  | { type: "json_schema"; name?: string; schema?: unknown; strict?: boolean; provider_payload?: unknown }
  | { type: string; provider_payload?: unknown; [key: string]: unknown }

export type EventServerHeartbeat = {
  type: "server.heartbeat"
  properties: Record<string, never>
}

export type EventSessionDeleted = {
  type: "session.deleted"
  /** `parentID` names a subsession, whose deletion leaves the visible session count alone. */
  properties: { info: { id: string; directory: string; parentID?: string } }
}

export function sessionDeleted(id: string, directory: string, parentID?: string): EventSessionDeleted {
  return { type: "session.deleted", properties: { info: { id, directory, ...(parentID ? { parentID } : {}) } } }
}

type SdkRuntimeOnlyEvent = EventServerHeartbeat | EventSessionDeleted

export type CompatEvent = AgentPresentationEvent | SdkRuntimeOnlyEvent

export type CompatEnvelope = {
  directory: string
  payload: CompatEvent
}

// These helpers are the package-level constructors for Claxedo client-presentation
// events. Route/adapters should use them instead of hand-assembling shapes
// except when they are validating external harness payloads.

/**
 * The presentation-shaped frames an adapter's stream may carry as-is: the
 * runtime commits one of these to the session's event log and publishes it
 * on the hub's global channel, and projects everything else as a raw
 * `AgentRuntimeEvent`. Deliberately a subset of `CompatEvent["type"]`:
 * `subagent.updated` and `goal.*` exist on the wire only as the projection
 * of their `subagent-updated` / `goal-*` runtime events, so admitting the
 * dot form here would publish a second copy outside the runtime channel;
 * `session.deleted` is published by the session routes straight to the
 * global channel; `message.removed` and `message.part.removed` have no
 * producer in this runtime.
 */
const kinds: ReadonlySet<string> = new Set<CompatEvent["type"]>([
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

export function withDir(directory: string, payload: CompatEvent): CompatEnvelope {
  return { directory, payload }
}

/** An unknown frame is a compat event when it names one of `kinds` and carries a properties object. */
function isCompatEvent(value: unknown): value is CompatEvent {
  const row = asRecord(value)
  return !!row && typeof row.type === "string" && kinds.has(row.type) && !!asRecord(row.properties)
}

export function toCompatEvent(input: unknown): CompatEvent | null {
  return isCompatEvent(input) ? input : null
}

export function eventSessionId(event: CompatEvent): string | undefined {
  // Global stream frames may be partial. A frame without a valid session
  // identity is ignored without terminating the shared stream.
  const properties = (event.properties ?? {}) as {
    info?: { id?: string; sessionID?: string }
    part?: { sessionID?: string }
    sessionID?: string
  }
  switch (event.type) {
    case "message.updated":
      return properties.info?.sessionID
    case "session.updated":
    case "session.deleted":
      return properties.info?.id
    case "message.part.updated":
      return properties.sessionID ?? properties.part?.sessionID
    case "message.part.delta":
      return properties.sessionID
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
    case "subagent.updated":
    case "goal.updated":
    case "goal.cleared":
      return properties.sessionID
    case "session.error":
      return properties.sessionID
    default:
      // A type this list does not name is still the session's when its
      // properties say so: the stream delivers a session-less frame to every
      // admitted principal, so failing open here would ship a new event kind
      // workspace-wide until someone added its case.
      return properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  }
}

export function isTerminalCompatEvent(event: CompatEvent): event is Extract<CompatEvent, { type: "session.idle" | "session.error" }> {
  return event.type === "session.idle" || event.type === "session.error"
}

/**
 * Frames a stream must not shed and its replay buffer keeps in reserve:
 * each settles a state machine the client renders and nothing re-states it
 * before the turn ends — a lost one pins a turn to busy, a subagent to
 * running, or a tool row to "Running" with its clock still ticking. A tool's
 * start and input snapshots are chatty and stay evictable. Distinct from
 * `isTerminalCompatEvent`, which is the adapters' "the prompt is over".
 */
export function isRetainedCompatEvent(event: CompatEvent): boolean {
  if (isTerminalCompatEvent(event)) return true
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
  model: { providerID: string; modelID: string }
  created?: number
  tools?: Record<string, boolean>
  format?: CompatPromptFormat
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
    model: input.model,
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
  model: { providerID: string; modelID: string }
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
  titleSource?: AgentSessionTitleSource
  created?: number
  updated?: number
  projectID?: string
  workspaceID?: string
}): AgentPresentationSession {
  const created = input.created ?? Date.now()
  const updated = input.updated ?? created
  return {
    id: input.id,
    slug: input.id,
    projectID: input.projectID ?? input.directory,
    ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}),
    directory: input.directory,
    title: input.title,
    ...(input.titleSource ? { titleSource: input.titleSource } : {}),
    version: "local",
    time: { created, updated },
  }
}

export function messageUpdated(info: EventMessageUpdated["properties"]["info"]): EventMessageUpdated {
  return {
    id: `message.updated:${info.id}`,
    type: "message.updated",
    properties: { sessionID: info.sessionID, info },
  }
}

/**
 * The user message's parts as the transcript records them. The route admits
 * only these three shapes (`isPromptPart`), so there is nothing left over to
 * fall back on — a file part recorded as a serialized string once, which
 * nothing on the client read back and every history read then carried.
 */
export function buildUserPromptParts(sessionID: string, messageID: string, parts: PromptInput["parts"]): CompatPart[] {
  return parts.map((part, index): CompatPart => {
    const id = part.id ?? `${messageID}-part-${index}`
    switch (part.type) {
      case "text":
        return { ...part, id, sessionID, messageID }
      case "agent":
        return { ...part, id, sessionID, messageID }
      case "file":
        return { ...part, id, sessionID, messageID }
    }
  })
}

/**
 * A part read back from persistence. Until 2026-09-17 the recorder above wrote
 * an attachment as a synthetic text part holding the file part's JSON, which
 * no reader drew; rows written that way read back as the file part they were.
 */
export function readRecordedPart<T extends Record<string, unknown>>(part: T): T | CompatPart {
  if (part.type !== "text" || part.synthetic !== true || typeof part.text !== "string" || !part.text.startsWith('{"')) return part
  let record: unknown
  try {
    record = JSON.parse(part.text)
  } catch {
    return part
  }
  const row = asRecord(record)
  if (row?.type !== "file") return part
  return parseAgentContentPart({ ...row, id: part.id, sessionID: part.sessionID, messageID: part.messageID }) ?? part
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

export function permissionAsked(properties: AgentPermission): EventPermissionAsked {
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

export function questionAsked(properties: AgentQuestion): EventQuestionAsked {
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

export function todoUpdated(sessionID: string, todos: Array<AgentTodo>): EventTodoUpdated {
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

export function sessionUpdated(info: AgentSession): EventSessionUpdated {
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
