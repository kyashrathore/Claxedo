import type {
  AgentConfigOption,
  AgentContentPart,
  AgentMessageInfo,
  AgentPermission,
  AgentQuestion,
  AgentSnapshotFileDiff,
  AgentTodo,
} from "./content"
import type { AgentRuntimeStatus } from "./availability"
import type { AgentRuntimeHealth, ConnectionRuntimeStatus } from "./connections"
import type { AgentSubagentUpdate, RuntimeGoalSnapshot } from "./subagents"

/**
 * Provider-reported token categories for one turn observation.
 *
 * `null` means the provider did not report the category. This is deliberately
 * different from a reported zero: metering consumers must never manufacture a
 * measured zero for an unknown category.
 */
export type RuntimeTokenUsage = {
  input: number | null
  output: number | null
  reasoning: number | null
  cache: {
    read: number | null
    write: number | null
    /**
     * The part of `write` held in the one-hour cache, which Anthropic bills at
     * 2x input instead of the five-minute 1.25x. Absent where the provider
     * reports no split; a write with no split is a five-minute write.
     */
    write1h?: number | null
  }
}

export type RuntimeUsageObservation = {
  /** Whether this observation replaces prior usage in its scope or adds to it. */
  kind: "cumulative" | "delta"
  /**
   * One independent stream of usage within the turn — a provider thread's own
   * turn, a subagent's requests. A cumulative observation replaces only its
   * scope's running total, and the turn's usage is the sum over every scope,
   * so two streams that land on one turn never overwrite each other. Absent is
   * the turn's own stream.
   */
  scope?: string
  tokens: RuntimeTokenUsage
  /**
   * The model id the provider reports having served these requests with, where
   * it names one. A session's configured model can be an alias (`opus[1m]`)
   * that no price list carries.
   */
  model?: string
  /** Provider-native ordering data when the source exposes it. */
  sequence?: number
  providerObservationId?: string
  /** Provider-native session/thread identity used only for local overlap classification. */
  nativeSessionId?: string
  observedAt?: number
}

export type AgentPresentationEvent =
  | { id: string; type: "message.updated"; properties: { sessionID: string; info: AgentMessageInfo & { sessionID: string } } }
  | { id: string; type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { id: string; type: "message.part.updated"; properties: { sessionID: string; part: AgentContentPart; time: number } }
  | { id: string; type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }
  | { id: string; type: "message.part.delta"; properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string } }
  /** `cancelled` marks the message a stopped turn ended on; the runtime records that turn as cancelled from it. */
  | { type: "message.completed"; properties: { sessionID: string; messageID: string; cancelled?: true } }
  | { id: string; type: "permission.asked"; properties: AgentPermission }
  | { id: string; type: "permission.replied"; properties: { sessionID: string; requestID: string } & ({ reply: "once" | "always" | "reject"; optionId?: never } | { optionId: string; reply?: never }) }
  | { id: string; type: "permission.expired"; properties: { sessionID: string; requestID: string } }
  | { id: string; type: "question.asked"; properties: AgentQuestion }
  | { id: string; type: "question.replied"; properties: { sessionID: string; requestID: string; answers: string[][] } }
  | { id: string; type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  | { id: string; type: "question.expired"; properties: { sessionID: string; requestID: string } }
  | { id: string; type: "todo.updated"; properties: { sessionID: string; todos: AgentTodo[] } }
  | { id: string; type: "session.status"; properties: { sessionID: string; status: AgentRuntimeStatus } }
  | { id: string; type: "session.idle"; properties: { sessionID: string } }
  | { id: string; type: "session.error"; properties: { sessionID?: string; error?: { name: string; data: Record<string, unknown> & { message?: string } } } }
  | { id: string; type: "session.updated"; properties: { sessionID: string; info: import("./sessions").AgentSession } }
  | { id: string; type: "session.diff"; properties: { sessionID: string; diff: AgentSnapshotFileDiff[] } }
  | { id: string; type: "session.compacted"; properties: { sessionID: string } }
  | { type: "session.agent"; properties: { sessionID: string; agentId: string } }
  | { type: "session.config"; properties: { sessionID: string; options: AgentConfigOption[] } }
  | { type: "session.commands"; properties: { sessionID: string; commands: import("./sessions").AgentSessionCommand[] } }
  | { type: "session.usage"; properties: { sessionID: string; messageID?: string; contextSize: number; contextUsed: number; observation?: RuntimeUsageObservation; cost?: { amount: number; currency: string } } }
  | { id?: string; type: "subagent.updated"; properties: { sessionID: string; update: AgentSubagentUpdate } }
  | { id?: string; type: "goal.updated"; properties: { sessionID: string; goal: RuntimeGoalSnapshot } }
  | { id?: string; type: "goal.cleared"; properties: { sessionID: string } }
  | { id?: string; type: "runtime.diagnostic"; properties: { sessionID: string; harness?: string; threadId?: string; projection?: string; phase?: "ingest" | "terminalize"; code: string; message: string; severity: "debug" | "info" | "warn" | "error"; eventType?: string; issues?: string[]; details?: unknown; auth?: unknown; rateLimit?: unknown; mcp?: unknown; diagnostic?: unknown; raw?: unknown } }
  | { id: string; type: "server.connected"; properties: Record<string, unknown> }
  | { type: "server.heartbeat"; properties: Record<string, unknown> }
  /** `parentID` names a subsession, whose deletion leaves the visible session count alone. */
  | { type: "session.deleted"; properties: { info: { id: string; directory: string; parentID?: string } } }
  /** Whether the session's harness runs work outside any turn; live state pushed when it changes and never journaled. */
  | { type: "session.background-work"; properties: { sessionID: string; active: boolean } }
  /** A session's harness health and its connection's state, pushed when either changes. */
  | { type: "harness.health"; properties: { sessionID: string; harnessHealth: AgentRuntimeHealth; connectionState?: ConnectionRuntimeStatus & { connectionId: string } } }

export type AgentPresentationEventType = AgentPresentationEvent["type"]

export const AGENT_PRESENTATION_EVENT_TYPE_REGISTRY = {
  "message.updated": true,
  "message.removed": true,
  "message.part.updated": true,
  "message.part.removed": true,
  "message.part.delta": true,
  "message.completed": true,
  "permission.asked": true,
  "permission.replied": true,
  "permission.expired": true,
  "question.asked": true,
  "question.replied": true,
  "question.rejected": true,
  "question.expired": true,
  "todo.updated": true,
  "session.status": true,
  "session.idle": true,
  "session.error": true,
  "session.updated": true,
  "session.diff": true,
  "session.compacted": true,
  "session.agent": true,
  "session.config": true,
  "session.commands": true,
  "session.usage": true,
  "subagent.updated": true,
  "goal.updated": true,
  "goal.cleared": true,
  "runtime.diagnostic": true,
  "server.connected": true,
  "server.heartbeat": true,
  "session.deleted": true,
  "harness.health": true,
  "session.background-work": true,
} satisfies Record<AgentPresentationEventType, true>

/** Sound because the registry is `satisfies Record<AgentPresentationEventType, true>`: its keys are exactly the union. */
export function isAgentPresentationEventType(value: string): value is AgentPresentationEventType {
  return Object.hasOwn(AGENT_PRESENTATION_EVENT_TYPE_REGISTRY, value)
}

export const AGENT_PRESENTATION_EVENT_TYPES: AgentPresentationEventType[] =
  Object.keys(AGENT_PRESENTATION_EVENT_TYPE_REGISTRY).filter(isAgentPresentationEventType)

export type AgentEventEnvelope<Event extends AgentPresentationEvent = AgentPresentationEvent> = {
  directory: string
  payload: Event
}

export type RuntimeQuestion = {
  text: string
  options?: string[]
  optionDescriptions?: Record<string, string>
  header?: string
  multiple?: boolean
  custom?: boolean
}
