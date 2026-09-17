import type { AgentMessage } from "./index"

/**
 * An authoritative transcript-window request. Cursors are opaque to every
 * consumer.
 *
 * Semantic views are intentionally distinct from numeric pages. `latest-turn`
 * returns the complete latest turn. `latest-surface` returns at most its owning
 * user and final message; its cursor points at the final message so ordinary
 * paging restores every omitted intermediate without a second cursor protocol.
 * The surface is a first-paint projection: the two envelopes whole, and their
 * text parts only, whole. It is what a folded turn draws — the prompt, the fold
 * row and the answer — so the answer is never the thing a budget trims.
 */
export type AgentMessagePageInput =
  | {
      view: "latest-turn" | "latest-surface"
      limit?: never
      before?: never
    }
  | {
      view?: never
      limit: number
      before?: string
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

export function isLatestSurfacePart(part: unknown) {
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

/**
 * An authoritative message-page producer rejected the request.
 *
 * Kept in this dependency-light module so HTTP and persistence boundaries can
 * preserve producer status without importing the harness adapter catalog.
 */
export class AgentMessagePageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "AgentMessagePageError"
  }
}
