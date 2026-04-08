import type { Message, Session } from "@opencode-ai/sdk/v2"

type Snapshot<T> = {
  sessionId: string
  value: T | undefined
}

export function stableSessionInfo(
  prev: Snapshot<Session> | undefined,
  sessionId: string | undefined,
  next: Session | undefined,
) {
  if (!sessionId || sessionId === "new") return
  if (next) return { sessionId, value: next }
  if (prev?.sessionId === sessionId) return prev
  return
}

export function stableSessionMessages(
  prev: Snapshot<Message[]> | undefined,
  sessionId: string | undefined,
  next: Message[] | undefined,
) {
  if (!sessionId || sessionId === "new") return
  if (next !== undefined) return { sessionId, value: next }
  if (prev?.sessionId === sessionId) return prev
  return { sessionId, value: undefined }
}
