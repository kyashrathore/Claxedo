import { formatEventCursor } from "@claxedo/agent-runtime-contract"

export type EventFeedCursor = {
  readonly advance: () => void
  readonly current: () => string
}

/**
 * Counts every frame this process's streams can carry, so a read and a stream
 * opened in the same process answer comparable positions. The feed id is this
 * process's own: a position another process issued never compares equal.
 */
export function createEventFeedCursor(): EventFeedCursor {
  const feed = crypto.randomUUID()
  let at = 0
  return {
    advance: () => {
      at += 1
    },
    current: () => formatEventCursor({ feed, at }),
  }
}
