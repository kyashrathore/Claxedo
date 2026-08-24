import {
  AgentMessagePageError,
  type AgentMessagePageInput,
} from "@claxedo/agent-sdk-runtime/message-page"

const MAX_MESSAGE_PAGE_LIMIT = 500

export function parseMessagePageInput(
  limit: string | undefined,
  before: string | undefined,
  view?: string,
): AgentMessagePageInput | undefined {
  if (view !== undefined) {
    if ((view !== "latest-turn" && view !== "latest-surface") || limit !== undefined || before !== undefined) {
      throw new AgentMessagePageError(400, "view must be latest-turn or latest-surface and cannot be combined with limit or before")
    }
    return { view }
  }
  if (limit === undefined && before === undefined) return undefined
  if (limit === undefined || !/^[1-9]\d*$/.test(limit)) {
    throw new AgentMessagePageError(400, `limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
  }
  const parsed = Number(limit)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_MESSAGE_PAGE_LIMIT) {
    throw new AgentMessagePageError(400, `limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
  }
  if (before !== undefined && before.length === 0) {
    throw new AgentMessagePageError(400, "before must be a non-empty cursor")
  }
  return {
    limit: parsed,
    ...(before === undefined ? {} : { before }),
  }
}

export function messagePageCursor(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const cursor = (body as { nextCursor?: unknown }).nextCursor
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined
}
