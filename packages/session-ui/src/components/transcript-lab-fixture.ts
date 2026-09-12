import {
  isAgentContentPart,
  isAgentMessageInfo,
  type AgentContentPart,
  type AgentPresentationMessage,
} from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import sessions from "./transcript-lab-fixture.json"

export type TranscriptLabSession = {
  id: string
  title: string
  sessionID: string
  /** Ordered; user messages first in their turn. Sorted by `id` for Binary.search. */
  messages: AgentPresentationMessage[]
  /** Keyed by messageID, matching Data["part"]. */
  parts: Record<string, AgentContentPart[]>
  /** Measured from the source log, for the lab's stats strip. */
  stats: {
    userTurns: number
    assistantMessages: number
    textParts: number
    reasoningParts: number
    /** Recent logs persist a thinking block's signature and drop its text; those parts render nothing. */
    reasoningWithText: number
    toolParts: number
    proseChars: number
    machineryChars: number
  }
  /** `partID: why` for every part not taken whole from a log. Absent when the session is entirely mined. */
  synthetic?: string[]
}

const STAT_KEYS = [
  "userTurns",
  "assistantMessages",
  "textParts",
  "reasoningParts",
  "reasoningWithText",
  "toolParts",
  "proseChars",
  "machineryChars",
] as const satisfies readonly (keyof TranscriptLabSession["stats"])[]

/** `isAgentMessageInfo` checks `tokens` whenever it is there, so the assistant branch only demands it. */
function isPresentationMessage(value: unknown): value is AgentPresentationMessage {
  if (!isAgentMessageInfo(value) || typeof value.agent !== "string") return false
  if (!isRecord(value.time) || typeof value.time.created !== "number") return false
  if (value.role === "user") {
    return isRecord(value.model)
      && typeof value.model.providerID === "string"
      && typeof value.model.modelID === "string"
  }
  return value.role === "assistant"
    && typeof value.parentID === "string"
    && typeof value.modelID === "string"
    && typeof value.providerID === "string"
    && typeof value.mode === "string"
    && typeof value.cost === "number"
    && isRecord(value.path)
    && typeof value.path.cwd === "string"
    && typeof value.path.root === "string"
    && value.tokens !== undefined
}

function isSession(value: unknown): value is TranscriptLabSession {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.sessionID !== "string") return false
  if (!Array.isArray(value.messages) || !value.messages.every(isPresentationMessage)) return false
  if (!isRecord(value.parts)) return false
  if (!Object.values(value.parts).every((parts) => Array.isArray(parts) && parts.every(isAgentContentPart))) return false
  const stats = value.stats
  if (!isRecord(stats) || !STAT_KEYS.every((key) => typeof stats[key] === "number")) return false
  if (value.synthetic === undefined) return true
  return Array.isArray(value.synthetic) && value.synthetic.every((note) => typeof note === "string")
}

/**
 * `bun run build:transcript-lab-fixture` writes the JSON; it lives beside this file as
 * data because transcripts quote real code, and under a `.ts` extension the repo's
 * source guards match markup-sink assignments and hex colours inside string literals.
 *
 * TypeScript reads the JSON's every `type` and `status` as `string` rather than the
 * contract's unions, so the narrowing happens here, against the contract's own guards.
 */
export const TRANSCRIPT_LAB_SESSIONS = sessions.map((session: unknown, index): TranscriptLabSession => {
  if (!isSession(session)) throw new Error(`transcript-lab-fixture.json[${index}] is not a lab session`)
  return session
})
