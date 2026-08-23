import type { AgentMessage } from "./index"

/** A bounded transcript request. Cursors are opaque to every consumer. */
export type AgentMessagePageInput = {
  limit: number
  before?: string
}

/** One chronological transcript page and the cursor for the next older page. */
export type AgentMessagePage = {
  messages: AgentMessage[]
  nextCursor?: string
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
