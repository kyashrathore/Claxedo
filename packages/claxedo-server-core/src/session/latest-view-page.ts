import { projectLatestSurfaceMessages, type LatestSurfaceMessage } from "@claxedo/agent-runtime-contract"
import type { AgentMessage } from "@claxedo/agent-runtime-contract"

export type LatestView = "latest-turn" | "latest-surface"

export type OrdinalMessage = { ordinal: number; message: unknown }

function isSurfaceMessage(value: unknown): value is LatestSurfaceMessage {
  if (!value || typeof value !== "object") return false
  const { info, parts } = value as { info?: unknown; parts?: unknown }
  return !!info && typeof info === "object" && Array.isArray(parts)
}

function isPrompt(value: unknown) {
  return isSurfaceMessage(value) && value.info.role === "user"
}

/**
 * A stored transcript's answer to a semantic view, from the latest turn's
 * messages (its own prompt first, in ordinal order): `latest-turn` is the
 * whole turn; `latest-surface` its prompts, including any steered into it,
 * and its final message, text parts only. The cursor pages back from the
 * turn's start, or for a surface from its final message, so ordinary `before`
 * paging restores what the surface left out.
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
  const selected = turn.filter((item) => item === last || isPrompt(item.message)).map((item) => item.message).filter(isSurfaceMessage)
  return {
    messages: projectLatestSurfaceMessages(selected),
    ...(olderExists || turn.length > 2 ? { nextCursor: cursorAt(last.ordinal) } : {}),
  }
}

/** A stored `latest-turn` page as a first page reads it; the stored rows are the runtime's synced message snapshots. */
export function storedTurn(page: { messages: readonly unknown[]; nextCursor?: string }): { messages: AgentMessage[]; nextCursor?: string } {
  return page as { messages: AgentMessage[]; nextCursor?: string }
}
