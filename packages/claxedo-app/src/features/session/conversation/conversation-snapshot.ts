import type { UIMessage } from "@tanstack/ai"
import type { Message } from "./agent-conversation"

export function compactConversationSnapshot(messages: UIMessage[] | undefined) {
  if (!messages) return messages
  const byId = new Map<string, UIMessage>()
  for (const message of messages) byId.set(message.id, message)
  return byId.size === messages.length ? messages : [...byId.values()]
}

function errorDetailRank(error: unknown) {
  if (!error || typeof error !== "object") return 0
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== "object") return 1
  const fields = data as { statusCode?: unknown; responseBody?: unknown; message?: unknown }
  let rank = 1
  if (typeof fields.message === "string" && fields.message.trim()) rank += 1
  if (typeof fields.statusCode === "number") rank += 2
  if (typeof fields.responseBody === "string" && fields.responseBody.trim()) rank += 2
  return rank
}

function richestError(current: Message | undefined, next: Message | undefined) {
  const incoming = next?.role === "assistant" ? next.error : undefined
  if (!incoming) return undefined
  const existing = current?.role === "assistant" ? current.error : undefined
  if (!existing) return incoming
  return errorDetailRank(existing) > errorDetailRank(incoming) ? existing : incoming
}

function withPreservedError(current: Message | undefined, next: Message): Message {
  if (next.role !== "assistant") return next
  const error = richestError(current, next)
  if (error === next.error) return next
  if (!error) {
    const { error: _dropped, ...rest } = next as Message & { error?: unknown }
    return rest as Message
  }
  return { ...next, error } as Message
}

// `claxedo.author` is declared on the contract's user message, so it is read
// through the narrowed arm rather than dug out of an untyped record.
function messageAuthor(message: Message | undefined) {
  return message?.role === "user" ? message.claxedo?.author : undefined
}

export function withPreservedAuthor(current: Message | undefined, next: Message): Message {
  if (next.role !== "user") return next
  const currentAuthor = messageAuthor(current)
  if (!currentAuthor || messageAuthor(next)) return next
  return { ...next, claxedo: { ...next.claxedo, author: currentAuthor } }
}

// `time.completed` is stamped once at turn end; a turn still answering stays
// pending, and a retry mints a new message id — so a stored settled stamp is
// never legitimately cleared by a later envelope. The one producer that omits
// it is retained-stream replay, whose stale envelope would otherwise un-settle
// the message and open the settled-part guard to duplicated late parts.
function withPreservedCompletion(current: Message | undefined, next: Message): Message {
  if (current?.role !== "assistant" || next.role !== "assistant") return next
  const completed = current.time?.completed
  if (typeof completed !== "number" || typeof next.time?.completed === "number") return next
  return { ...next, time: { ...next.time, completed } } as Message
}

export function preserveMessageFields(current: Message | undefined, next: Message): Message {
  return withPreservedAuthor(current, withPreservedCompletion(current, withPreservedError(current, next)))
}
