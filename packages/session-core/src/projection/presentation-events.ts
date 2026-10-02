import type {
  AgentContentPart,
  AgentEventEnvelope,
  AgentMessageAuthor,
  AgentMessageInfo,
  AgentPermission,
  AgentPresentationEvent,
  AgentQuestion,
  AgentRuntimeStatus,
  AgentSessionTitleSource,
  AgentSnapshotFileDiff,
  AgentTodo,
  FirstTurnErrorClass,
  PromptFormat,
  PromptInput,
  TurnAccount,
} from "@claxedo/agent-runtime-contract"
import { backgroundWorkActive, firstTurnErrorData, promptPartId, type BackgroundWork } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { withClaxedoMessageAuthor } from "./client-presentation/author"

type Event<T extends AgentPresentationEvent["type"]> = Extract<AgentPresentationEvent, { type: T }>

export function sessionDeleted(id: string, directory: string, parentID?: string): Event<"session.deleted"> {
  return { type: "session.deleted", properties: { info: { id, directory, ...(parentID ? { parentID } : {}) } } }
}

export function harnessHealthChanged(properties: Event<"harness.health">["properties"]): Event<"harness.health"> {
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

export function withDir<Payload extends AgentPresentationEvent>(directory: string, payload: Payload): AgentEventEnvelope<Payload> {
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

function isTerminalPresentationEvent(event: AgentPresentationEvent): event is Event<"session.idle" | "session.error"> {
  return event.type === "session.idle" || event.type === "session.error"
}

/**
 * Frames a stream must not shed and its replay buffer keeps in reserve: each
 * settles a state machine the client renders, and nothing re-states it on the
 * stream. A lost one pins a turn to busy, a subagent to running, a tool row to
 * "Running" with its clock still ticking, or a session to in progress after
 * its background work settled. Starts and tool input snapshots are chatty and
 * stay evictable. Distinct from `isTerminalPresentationEvent`, which is a
 * transport's "the prompt is over".
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
  if (event.type === "session.background-work") return !backgroundWorkActive(event.properties)
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

export function messageUpdated(info: Event<"message.updated">["properties"]["info"]): Event<"message.updated"> {
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

export function messagePartUpdated(part: AgentContentPart, time = Date.now()): Event<"message.part.updated"> {
  return {
    id: `message.part.updated:${part.messageID}:${part.id}`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time,
    },
  }
}

export function messagePartDelta(input: {
  sessionID: string
  messageID: string
  partID: string
  field: string
  delta: string
}): Event<"message.part.delta"> {
  return {
    id: `message.part.delta:${input.messageID}:${input.partID}`,
    type: "message.part.delta",
    properties: input,
  }
}

export function messageCompleted(sessionID: string, messageID: string, cancelled?: true): Event<"message.completed"> {
  return {
    type: "message.completed",
    properties: { sessionID, messageID, ...(cancelled ? { cancelled } : {}) },
  }
}

export function permissionAsked(properties: AgentPermission): Event<"permission.asked"> {
  return {
    id: `permission.asked:${properties.id}`,
    type: "permission.asked",
    properties,
  }
}

export function questionAsked(properties: AgentQuestion): Event<"question.asked"> {
  return {
    id: `question.asked:${properties.id}`,
    type: "question.asked",
    properties,
  }
}

export function questionReplied(sessionID: string, requestID: string, answers: Array<Array<string>>): Event<"question.replied"> {
  return {
    id: `question.replied:${requestID}`,
    type: "question.replied",
    properties: { sessionID, requestID, answers },
  }
}

export function todoUpdated(sessionID: string, todos: Array<AgentTodo>): Event<"todo.updated"> {
  return {
    id: `todo.updated:${sessionID}`,
    type: "todo.updated",
    properties: { sessionID, todos },
  }
}

export function sessionStatus(sessionID: string, status: AgentRuntimeStatus): Event<"session.status"> {
  return {
    id: `session.status:${sessionID}`,
    type: "session.status",
    properties: { sessionID, status },
  }
}

export function sessionBackgroundWork(sessionID: string, work: BackgroundWork): Event<"session.background-work"> {
  return { type: "session.background-work", properties: { sessionID, ...work } }
}

export function sessionCompacted(sessionID: string): Event<"session.compacted"> {
  return {
    id: `session.compacted:${sessionID}`,
    type: "session.compacted",
    properties: { sessionID },
  }
}

export function sessionDiff(sessionID: string, diff: AgentSnapshotFileDiff[]): Event<"session.diff"> {
  return {
    id: `session.diff:${sessionID}`,
    type: "session.diff",
    properties: { sessionID, diff },
  }
}

export function sessionIdle(sessionID: string): Event<"session.idle"> {
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
): Event<"session.error"> {
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

export function sessionUpdated(info: Event<"session.updated">["properties"]["info"]): Event<"session.updated"> {
  return {
    id: `session.updated:${info.id}`,
    type: "session.updated",
    properties: { sessionID: info.id, info },
  }
}

export function sessionAgent(sessionID: string, agentId: string): Event<"session.agent"> {
  return {
    type: "session.agent",
    properties: { sessionID, agentId },
  }
}

export function sessionConfig(properties: Event<"session.config">["properties"]): Event<"session.config"> {
  return {
    type: "session.config",
    properties,
  }
}

export function sessionUsage(properties: Event<"session.usage">["properties"]): Event<"session.usage"> {
  return {
    type: "session.usage",
    properties,
  }
}

export function runtimeDiagnostic(properties: Event<"runtime.diagnostic">["properties"]): Event<"runtime.diagnostic"> {
  return {
    id: `runtime.diagnostic:${properties.sessionID}:${properties.code}`,
    type: "runtime.diagnostic",
    properties,
  }
}

/**
 * `title` absent leaves the stored title alone; `null` clears it. A harness
 * that reports only `updatedAt` must not blank a title it never mentioned.
 */
export function buildSession(input: {
  id: string
  directory: string
  title?: string | null
  titleSource?: AgentSessionTitleSource
  created: number
  updated: number
  parentID?: string
  sessionRef?: string
  host?: "workspace"
  workspaceID?: string
}): Event<"session.updated">["properties"]["info"] {
  return {
    id: input.id,
    slug: input.id,
    projectID: input.directory,
    directory: input.directory,
    ...(input.parentID ? { parentID: input.parentID } : {}),
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}),
    ...(input.title !== undefined ? { title: input.title, titleSource: input.titleSource ?? "harness" } : {}),
    version: "local",
    time: { created: input.created, updated: input.updated },
  }
}
