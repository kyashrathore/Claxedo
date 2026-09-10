import type { AgentContentPart, AgentPresentationMessage } from "@claxedo/agent-runtime-contract"
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

/**
 * `bun run build:transcript-lab-fixture` writes the JSON; it lives beside this file as
 * data because transcripts quote real code, and under a `.ts` extension the repo's
 * source guards match markup-sink assignments and hex colours inside string literals.
 *
 * TypeScript reads the JSON as its own literal type, where every `type` and `status`
 * is `string` rather than the contract's unions, so the two are not structurally
 * assignable. The assertion is the one boundary that claim is made at; the generator
 * builds every part from the contract's shapes, and `bun run typecheck` covers it there.
 */
export const TRANSCRIPT_LAB_SESSIONS = sessions as unknown as TranscriptLabSession[]
