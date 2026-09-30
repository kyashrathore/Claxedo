import { base64UrlDecode, base64UrlEncode } from "@claxedo/helpers/crypto"
import { asRecord } from "@claxedo/helpers/guards"
import type { AgentMessage } from "./content"
import type { AgentTurnOutcome } from "./sessions"

/** The most messages a numeric page may ask for; every producer rejects a larger `limit`. */
export const AGENT_MESSAGE_PAGE_LIMIT = 500

/**
 * An authoritative transcript-window request. Cursors are opaque to every
 * consumer.
 *
 * Semantic views are intentionally distinct from numeric pages. `latest-turn`
 * returns the complete latest turn, or with `before` the complete turn that
 * ends at that cursor; its cursor points at the turn's user message, so a
 * reader walks back one whole turn per read. `latest-surface` returns at most
 * its owning user and final message; its cursor points at the final message so
 * ordinary paging restores every omitted intermediate without a second cursor
 * protocol. The surface is a first-paint projection: the two envelopes whole,
 * and their text parts only, whole. It is what a folded turn draws — the
 * prompt, the fold row and the answer — so the answer is never the thing a
 * budget trims.
 */
export type AgentMessagePageInput =
  | {
      view: "latest-turn"
      limit?: never
      before?: string
    }
  | {
      view: "latest-surface"
      limit?: never
      before?: never
    }
  | {
      view?: never
      limit: number
      before?: string
    }

/**
 * A coverage request for one named turn, answered by whoever owns its journal.
 *
 * Either of the turn's two message ids names it: a caller that admitted the
 * turn holds the user message id, while the journal keys the turn on the
 * assistant message id, and neither side can derive the other.
 */
type AgentTurnCoverageInput = {
  turnId: string
}

/** What a `GET /session/:id/message` read asks for; the shapes are exclusive. */
export type AgentMessageReadInput = AgentMessagePageInput | AgentTurnCoverageInput

/**
 * How much of one turn a producer can account for.
 *
 * `complete` is a claim that nothing more will be added to this turn and that
 * every message of it is in `messages`; only a producer holding the turn's
 * journal can make it. `partial` names a turn whose extent is known and whose
 * transcript is not all here yet. `unavailable` is the answer of a producer
 * that cannot establish either, and it always carries a reason.
 */
export type AgentTurnCoverage = "complete" | "partial" | "unavailable"

/** One turn, and how much of it the answering producer can account for. */
export type AgentTurnCoveragePage = {
  /** The turn that was asked for, never the turn the producer found instead. */
  turnId: string
  coverage: AgentTurnCoverage
  /** Why the coverage is not `complete`, from the producer that decided it. */
  reason?: string
  /** Present only when the journal records the turn finished. */
  terminal?: AgentTurnOutcome
  /** The last journal sequence the answering projection applied, not the journal's head. */
  committedSequence: number
  messages: AgentMessage[]
}

/** One chronological transcript page and the cursor for the next older page. */
export type AgentMessagePage = {
  /** Committed event-log position represented by a runtime-owned projection. */
  maxEventOrdinal?: number
  messages: AgentMessage[]
  nextCursor?: string
}

/** The message shape the latest-surface projection reads. */
export type LatestSurfaceMessage = { info: Record<string, unknown>; parts: unknown[] }

function isLatestSurfacePart(part: unknown) {
  return !!part && typeof part === "object" && (part as { type?: unknown }).type === "text"
}

/**
 * Apply the producer-independent `latest-surface` projection: every text part
 * of the message, in canonical order, and nothing else.
 */
export function projectLatestSurfaceMessage<TMessage extends LatestSurfaceMessage>(message: TMessage): TMessage {
  return { ...message, parts: message.parts.filter(isLatestSurfacePart) }
}

export function projectLatestSurfaceMessages<TMessage extends LatestSurfaceMessage>(
  messages: readonly TMessage[],
): TMessage[] {
  return messages.map(projectLatestSurfaceMessage)
}

/** An authoritative message-page producer rejected the request. */
export class AgentMessagePageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "AgentMessagePageError"
  }
}

/**
 * The `before` cursor a message-page producer hands out: its own prefix, then
 * the session and the ordinal the next page ends before. A cursor from another
 * producer or for another session is refused like a malformed one.
 */
export function encodeMessagePageCursor(prefix: string, sessionId: string, ordinal: number): string {
  return `${prefix}${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sessionId, ordinal })))}`
}

export function decodeMessagePageCursor(prefix: string, sessionId: string, input: string): number {
  try {
    if (!input.startsWith(prefix)) throw new Error("unexpected cursor version")
    const value = asRecord(JSON.parse(new TextDecoder().decode(base64UrlDecode(input.slice(prefix.length)))))
    const ordinal = value?.ordinal
    if (value?.sessionId !== sessionId || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error("invalid cursor payload")
    }
    return ordinal
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

/** The `limit`/`before`/`view` query of a message page read; every producer refuses a malformed one with a 400. */
export function parseMessagePageQuery(
  limit: string | undefined,
  before: string | undefined,
  view?: string,
): AgentMessagePageInput | undefined {
  if (view === "latest-turn" && limit === undefined) {
    if (before === undefined) return { view }
    if (before.length === 0) throw new AgentMessagePageError(400, "before must be a non-empty cursor")
    return { view, before }
  }
  if (view !== undefined) {
    if (view !== "latest-surface" || limit !== undefined || before !== undefined) {
      throw new AgentMessagePageError(400, "view must be latest-turn or latest-surface, cannot be combined with limit, and only latest-turn takes before")
    }
    return { view }
  }
  if (limit === undefined && before === undefined) return undefined
  if (limit === undefined || !/^[1-9]\d*$/.test(limit)) {
    throw new AgentMessagePageError(400, `limit must be an integer between 1 and ${AGENT_MESSAGE_PAGE_LIMIT}`)
  }
  const parsed = Number(limit)
  if (!Number.isSafeInteger(parsed) || parsed > AGENT_MESSAGE_PAGE_LIMIT) {
    throw new AgentMessagePageError(400, `limit must be an integer between 1 and ${AGENT_MESSAGE_PAGE_LIMIT}`)
  }
  if (before !== undefined && before.length === 0) {
    throw new AgentMessagePageError(400, "before must be a non-empty cursor")
  }
  return {
    limit: parsed,
    ...(before === undefined ? {} : { before }),
  }
}
