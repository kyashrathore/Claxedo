import { projectLatestSurfaceMessages, type LatestSurfaceMessage } from "@claxedo/agent-sdk-runtime/message-page"

export type LatestView = "latest-turn" | "latest-surface"

export type OrdinalMessage = { ordinal: number; message: unknown }

function isSurfaceMessage(value: unknown): value is LatestSurfaceMessage {
  if (!value || typeof value !== "object") return false
  const { info, parts } = value as { info?: unknown; parts?: unknown }
  return !!info && typeof info === "object" && Array.isArray(parts)
}

/**
 * A stored transcript's answer to a semantic view, from the latest turn's
 * messages (its user message first, in ordinal order): `latest-turn` is the
 * whole turn; `latest-surface` its user message and its final message, text
 * parts only. The cursor pages back from the turn's start, or for a surface
 * from its final message, so ordinary `before` paging restores what the
 * surface left out.
 */
export function latestViewPage(
  view: LatestView,
  turn: readonly OrdinalMessage[],
  olderExists: boolean,
  cursorAt: (ordinal: number) => string,
): { messages: unknown[]; nextCursor?: string } {
  const first = turn[0]
  const last = turn.at(-1)
  if (!first || !last) return { messages: [] }
  if (view === "latest-turn") {
    return { messages: turn.map((item) => item.message), ...(olderExists ? { nextCursor: cursorAt(first.ordinal) } : {}) }
  }
  const selected = (first === last ? [first] : [first, last]).map((item) => item.message).filter(isSurfaceMessage)
  return {
    messages: projectLatestSurfaceMessages(selected),
    ...(olderExists || turn.length > 2 ? { nextCursor: cursorAt(last.ordinal) } : {}),
  }
}
