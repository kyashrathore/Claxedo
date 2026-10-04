import type { AgentMessage, AgentPermission, AgentPresentationEvent, AgentQuestion, AgentSessionCommand, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { Turn, TurnFinish } from "./store"

/** A nullable text column's read: `null` kept as `null`, a string as itself, anything else `undefined`. */
export function nullable(input: unknown): string | null | undefined {
  if (input === null) return null
  return typeof input === "string" ? input : undefined
}

export function actorKind(input: unknown): "human" | "agent" | undefined {
  return input === "human" || input === "agent" ? input : undefined
}

export const readColumn = {
  sessionCommands: (json: string): AgentSessionCommand[] => JSON.parse(json),
  messageInfo: (json: string): AgentMessage["info"] => JSON.parse(json),
  messageRecord: (json: string): Record<string, unknown> => JSON.parse(json),
  messagePart: (json: string): AgentMessage["parts"][number] => JSON.parse(json),
  partRecord: (json: string): Record<string, unknown> => JSON.parse(json),
  /** `runtime_journal.payload_json` on a `kind='control'`, `type='turn.start'` row. */
  turnStart: (json: string): Turn => JSON.parse(json),
  /** `runtime_journal.payload_json` on a `kind='control'`, `type='turn.finish'` row. */
  turnFinish: (json: string): TurnFinish => JSON.parse(json),
  /** `runtime_journal.payload_json` on a `kind='event'` row: an engine envelope. */
  eventPayload: (json: string): { properties?: Record<string, unknown> } => JSON.parse(json),
  /** `runtime_journal.payload_json` on a `kind='event'`, `type='session.usage'` row. */
  usagePayload: (json: string): Extract<AgentPresentationEvent, { type: "session.usage" }> => JSON.parse(json),
  /** `pending_permission.patterns_json`. */
  permissionPatterns: (json: string): string[] => JSON.parse(json),
  /** `pending_permission.options_json`: absent is distinct from no offered options. */
  permissionOptions: (json: string): NonNullable<AgentPermission["options"]> => JSON.parse(json),
  /** `pending_permission.metadata_json`. */
  permissionMetadata: (json: string): Record<string, unknown> => JSON.parse(json),
  /**
   * `pending_question.questions_json`, written by the `question.asked` handler
   * straight from the event's own `properties.questions`.
   */
  questions: (json: string): AgentQuestion["questions"] => JSON.parse(json),
  /** `session_subagent_observation.event_json`. */
  subagentEvent: (json: string): SubagentUpdatedEvent => JSON.parse(json),
}
