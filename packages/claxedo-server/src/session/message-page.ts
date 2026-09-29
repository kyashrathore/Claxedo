import { AgentMessagePageError } from "@claxedo/agent-runtime-contract"

export function parseSessionPartInput(messageId: string | undefined, partId: string | undefined): { messageId: string; partId: string } {
  if (!messageId || !partId) throw new AgentMessagePageError(400, "messageId and partId are required")
  return { messageId, partId }
}

export function messagePageCursor(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const cursor = (body as { nextCursor?: unknown }).nextCursor
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined
}
