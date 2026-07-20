import type { Event, Message, Part, ToolState } from "@opencode-ai/sdk/v2/client"
import type { MessagePart, UIMessage } from "@tanstack/ai"

export type ConversationChatHandle = {
  messages: () => UIMessage[]
  setMessages: (messages: UIMessage[]) => void
}

type ConversationUIMessage = UIMessage & {
  metadata?: {
    opencodeMessage?: Message
  }
}

type ConversationMessagePart = MessagePart & {
  metadata?: {
    opencodePartId?: string
    opencodePart?: Part
    [key: string]: unknown
  }
}

export function opencodeConversationSnapshot(input: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
}) {
  return input.messages.map((message) =>
    opencodeMessageToChatMessage({
      message,
      parts: input.parts[message.id] ?? [],
    })
  )
}

// Incremental projection cache. Keyed by the UIMessage object, so an unchanged
// message (stable reference — our event-apply path replaces only the changed
// index) reuses its previously-projected OpenCode Message + Part[] instead of
// re-running the per-part mapping. During streaming only the last message has a
// new reference, so projection cost is O(changed) rather than O(all messages)
// per token. WeakMap → entries are GC'd when a message object is replaced.
const projectionCache = new WeakMap<UIMessage, { message: Message; parts: Part[] }>()

export function opencodeConversationProjection(messages: UIMessage[]) {
  const parts: Record<string, Part[] | undefined> = {}
  const projected = messages.map((message) => {
    let entry = projectionCache.get(message)
    if (!entry) {
      entry = {
        message: chatMessageToOpencodeMessage(message),
        parts: message.parts.flatMap((part) => chatPartToOpencodePart(message, part)),
      }
      projectionCache.set(message, entry)
    }
    parts[message.id] = entry.parts
    return entry.message
  })
  return {
    messages: projected,
    parts,
  }
}

export function mergeConversationSnapshot(current: UIMessage[], snapshot: UIMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message] as const))
  for (const message of snapshot) {
    const existing = byId.get(message.id)
    byId.set(message.id, existing ? mergeChatMessage(existing, message) : message)
  }
  return sortMessages([...byId.values()])
}

export function applyOpencodeConversationEvent(chat: ConversationChatHandle, event: Event) {
  if (event.type === "message.updated") {
    return upsertMessage(chat, propertyRecord(event.properties)?.info as Message | undefined)
  }
  if (event.type === "message.removed") {
    return removeMessage(chat, messageIdFromEvent(event))
  }
  if (event.type === "message.part.updated") {
    return upsertPart(chat, propertyRecord(event.properties)?.part as Part | undefined)
  }
  if (event.type === "message.part.removed") {
    return removePart(chat, messageIdFromEvent(event), partIdFromEvent(event))
  }
  if (event.type === "message.part.delta") {
    const props = propertyRecord(event.properties)
    return appendPartDelta(
      chat,
      text(props?.messageID),
      text(props?.partID),
      text(props?.delta),
    )
  }
  return false
}

function mergeChatMessage(current: UIMessage, snapshot: UIMessage): UIMessage {
  // For a settled (completed) assistant message the fetched snapshot's part
  // list is authoritative: matching parts still merge (preserving longer live
  // text), but chat-only parts are dropped rather than re-appended. Streamed
  // parts carry projection-synthesized ids that can differ from the persisted
  // ids for the same content (e.g. `000000_<msgId>-text` vs `<msgId>_text`),
  // so appending them alongside the persisted part renders the reply twice.
  if (settledAssistantMessage(snapshot) && snapshot.parts.length > 0) {
    return {
      ...snapshot,
      parts: snapshot.parts.map((part) => {
        const id = opencodePartId(part)
        const existing = id ? current.parts.find((item) => opencodePartId(item) === id) : undefined
        return existing ? mergeChatPart(existing, part) : part
      }),
    }
  }
  return {
    ...snapshot,
    parts: mergeChatParts(current.parts, snapshot.parts),
  }
}

/**
 * True when the message is an assistant message whose turn has settled
 * (`time.completed` stamped). Once settled, the persisted history is the
 * source of truth for the message's parts: late-delivered streamed part
 * events (SSE batches racing the REST history refetch) must not append new
 * parts, or the same logical content shows up twice under two part ids.
 */
function settledAssistantMessage(message: UIMessage) {
  const stored = (message as ConversationUIMessage).metadata?.opencodeMessage
  if (!stored || stored.role !== "assistant") return false
  return typeof (stored.time as { completed?: number } | undefined)?.completed === "number"
}

function hasChatPart(message: UIMessage, partID: string) {
  return message.parts.some((part) => opencodePartId(part) === partID)
}

function mergeChatParts(current: MessagePart[], snapshot: MessagePart[]) {
  const next = [...snapshot]
  for (const part of current) {
    const id = opencodePartId(part)
    const index = id ? next.findIndex((item) => opencodePartId(item) === id) : -1
    if (index === -1) {
      next.push(part)
      continue
    }
    next[index] = mergeChatPart(part, next[index]!)
  }
  return next
}

function mergeChatPart(current: MessagePart, snapshot: MessagePart) {
  if (
    (current.type === "text" || current.type === "thinking") &&
    snapshot.type === current.type &&
    textContent(snapshot).length >= textContent(current).length
  ) {
    return snapshot
  }
  return current
}

function textContent(part: MessagePart) {
  if (part.type === "text" || part.type === "thinking") return part.content ?? ""
  return ""
}

function upsertMessage(chat: ConversationChatHandle, message: Message | undefined) {
  if (!message?.id) return false
  const current = chat.messages()
  const index = current.findIndex((item) => item.id === message.id)
  const existing = index === -1 ? undefined : current[index]
  const next = opencodeMessageToChatMessage({
    message,
    parts: existing?.parts ?? [],
  })
  chat.setMessages(index === -1 ? sortMessages([...current, next]) : replaceAt(current, index, next))
  return true
}

function removeMessage(chat: ConversationChatHandle, messageID: string | undefined) {
  if (!messageID) return false
  const current = chat.messages()
  const next = current.filter((message) => message.id !== messageID)
  if (next.length === current.length) return false
  chat.setMessages(next)
  return true
}

function upsertPart(chat: ConversationChatHandle, part: Part | undefined) {
  if (!part?.messageID) return false
  const mapped = opencodePartToChatParts(part)
  if (mapped.length === 0) return false
  const current = chat.messages()
  const index = current.findIndex((message) => message.id === part.messageID)
  if (index === -1) return false
  const message = current[index]!
  // A settled assistant message only accepts updates to parts it already has —
  // a late-delivered streamed part (delayed SSE batch arriving after the REST
  // history refetch landed the completed message) must not append a second
  // copy of content the persisted part already carries under a different id.
  if (settledAssistantMessage(message) && !hasChatPart(message, part.id)) return false
  chat.setMessages(replaceAt(current, index, {
    ...message,
    parts: upsertChatParts(message.parts, part.id, mapped),
  }))
  return true
}

function removePart(chat: ConversationChatHandle, messageID: string | undefined, partID: string | undefined) {
  if (!messageID || !partID) return false
  const current = chat.messages()
  const index = current.findIndex((message) => message.id === messageID)
  if (index === -1) return false
  const message = current[index]!
  const nextParts = message.parts.filter((part) => opencodePartId(part) !== partID)
  if (nextParts.length === message.parts.length) return false
  chat.setMessages(replaceAt(current, index, {
    ...message,
    parts: nextParts,
  }))
  return true
}

function appendPartDelta(
  chat: ConversationChatHandle,
  messageID: string | undefined,
  partID: string | undefined,
  delta: string | undefined,
) {
  if (!messageID || !partID || delta === undefined) return false
  const current = chat.messages()
  const index = current.findIndex((message) => message.id === messageID)
  if (index === -1) return false
  const message = current[index]!
  // Same settled-message guard as upsertPart: a delta for a part the settled
  // message does not have would create a fresh part and duplicate the reply.
  if (settledAssistantMessage(message) && !hasChatPart(message, partID)) return false
  chat.setMessages(replaceAt(current, index, {
    ...message,
    parts: appendTextDelta(message.parts, partID, delta),
  }))
  return true
}

function opencodeMessageToChatMessage(input: {
  message: Message
  parts: Array<Part | MessagePart>
}): UIMessage {
  return {
    id: input.message.id,
    role: input.message.role,
    createdAt: new Date(input.message.time.created),
    metadata: { opencodeMessage: input.message },
    parts: input.parts.flatMap((part) => isOpencodePart(part) ? opencodePartToChatParts(part) : [part]),
  } as UIMessage
}

function opencodePartToChatParts(part: Part): MessagePart[] {
  if (part.type === "text") {
    return [{
      type: "text",
      content: part.text,
      metadata: { opencodePartId: part.id, opencodePart: part },
    }]
  }
  if (part.type === "reasoning") {
    return [{
      type: "thinking",
      stepId: part.id,
      content: part.text,
      signature: typeof part.metadata?.signature === "string" ? part.metadata.signature : undefined,
      metadata: { opencodePartId: part.id, opencodePart: part },
    } as MessagePart]
  }
  if (part.type === "file") {
    const source = {
      type: "url" as const,
      value: part.url,
      mimeType: part.mime,
    }
    if (part.mime.startsWith("image/")) {
      return [{
        type: "image",
        source,
        metadata: { opencodePartId: part.id, opencodePart: part, filename: part.filename },
      }]
    }
    return [{
      type: "document",
      source,
      metadata: { opencodePartId: part.id, opencodePart: part, filename: part.filename },
    }]
  }
  if (part.type === "tool") {
    return [{
      type: "tool-call",
      id: part.callID,
      name: part.tool,
      arguments: JSON.stringify(part.state.input ?? {}),
      state: toolCallState(part.state),
      output: toolOutput(part.state),
      metadata: { ...part.metadata, opencodePartId: part.id, opencodePart: part },
    }]
  }
  // Compaction markers carry no payload beyond their type/id. TanStack's MessagePart
  // union has no "compaction" variant, so (like "agent") we carry it as a custom-typed
  // part and stash the original for a lossless round-trip. Dropping it here silently
  // hid the assistant-timeline compaction divider (PART_MAPPING["compaction"]).
  if (part.type === "compaction") {
    return [{
      type: "compaction",
      metadata: { opencodePartId: part.id, opencodePart: part },
      // as-any: MessagePart union has no "compaction" variant; carry it as a custom part.
    } as unknown as MessagePart]
  }
  // @-mention parts. TanStack's MessagePart union has no "agent" variant, so we
  // carry the mention as a custom-typed part (cast, like "thinking") and stash
  // the original AgentPart in metadata for a lossless round-trip back to
  // OpenCode. Dropping this here silently hid mentions in the timeline.
  if (part.type === "agent") {
    return [{
      type: "agent",
      name: part.name,
      ...(part.source ? { source: part.source } : {}),
      metadata: { opencodePartId: part.id, opencodePart: part },
      // as-any: MessagePart union has no "agent" variant; carry it as a custom part (like "thinking").
    } as unknown as MessagePart]
  }
  return []
}

function upsertChatParts(current: MessagePart[], partID: string, next: MessagePart[]) {
  const index = current.findIndex((part) => opencodePartId(part) === partID)
  if (index === -1) return [...current, ...next]
  return [
    ...current.slice(0, index),
    ...next,
    ...current.slice(index + 1),
  ]
}

function appendTextDelta(parts: MessagePart[], partID: string, delta: string) {
  const index = parts.findIndex((part) => opencodePartId(part) === partID)
  if (index === -1) {
    return [
      ...parts,
      { type: "text" as const, content: delta, metadata: { opencodePartId: partID } },
    ]
  }
  const part = parts[index]!
  if (part.type === "text") {
    return replaceAt(parts, index, {
      ...part,
      content: part.content + delta,
    })
  }
  if (part.type === "thinking") {
    return replaceAt(parts, index, {
      ...part,
      content: part.content + delta,
    })
  }
  return parts
}

function opencodePartId(part: MessagePart) {
  if (part.type === "thinking") return part.stepId
  const metadata = propertyRecord((part as { metadata?: unknown }).metadata)
  return text(metadata?.opencodePartId)
}

function chatMessageToOpencodeMessage(message: UIMessage) {
  const stored = ((message as ConversationUIMessage).metadata?.opencodeMessage)
  if (stored) return {
    ...stored,
    role: message.role,
    time: {
      ...stored.time,
      created: message.createdAt?.getTime() ?? stored.time.created,
    },
  } as Message
  return {
    id: message.id,
    role: message.role,
    sessionID: "",
    time: { created: message.createdAt?.getTime() ?? 0 },
  } as Message
}

function chatPartToOpencodePart(message: UIMessage, part: MessagePart) {
  const metadata = (part as ConversationMessagePart).metadata
  const stored = metadata?.opencodePart
  if (part.type === "text") {
    return [stored ? {
      ...stored,
      type: "text",
      messageID: message.id,
      text: part.content,
    } as Part : {
      id: metadata?.opencodePartId ?? `${message.id}:text`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "text",
      text: part.content,
    } as Part]
  }
  if (part.type === "thinking") {
    return [stored ? {
      ...stored,
      type: "reasoning",
      messageID: message.id,
      text: part.content,
    } as Part : {
      id: part.stepId ?? `${message.id}:reasoning`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "reasoning",
      text: part.content,
    } as Part]
  }
  if (part.type === "tool-call" && stored) {
    return [{
      ...stored,
      messageID: message.id,
    }]
  }
  if ((part.type === "image" || part.type === "document") && stored) {
    return [{
      ...stored,
      messageID: message.id,
    }]
  }
  // Compaction marker → OpenCode CompactionPart. Reuse the stored original when
  // present (lossless); otherwise reconstruct the minimal envelope.
  if ((part.type as string) === "compaction") {
    return [stored ? { ...stored, messageID: message.id } : {
      id: metadata?.opencodePartId ?? `${message.id}:compaction`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "compaction",
    } as Part]
  }
  // Agent mention → OpenCode AgentPart. Reuse the stored original when present
  // (lossless); otherwise reconstruct from the carried name/source (the path a
  // freshly-composed optimistic user message takes before the server echoes it).
  if ((part.type as string) === "agent") {
    // as-any: read the custom "agent" MessagePart's carried fields (outside TanStack's union) to rebuild the AgentPart.
    const agent = part as unknown as { name?: string; source?: { value: string; start: number; end: number } }
    return [stored ? { ...stored, messageID: message.id } : {
      id: metadata?.opencodePartId ?? `${message.id}:agent`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "agent",
      name: agent.name ?? "",
      ...(agent.source ? { source: agent.source } : {}),
    } as Part]
  }
  return []
}

function chatMessageSessionId(message: UIMessage) {
  const stored = (message as ConversationUIMessage).metadata?.opencodeMessage
  return stored?.sessionID ?? ""
}

function toolCallState(state: ToolState) {
  if (state.status === "pending") return "awaiting-input"
  if (state.status === "running") return "input-complete"
  return "complete"
}

function toolOutput(state: ToolState) {
  if (state.status === "completed") return state.output
  if (state.status === "error") return state.error
  return undefined
}

function sortMessages(messages: UIMessage[]) {
  return messages.slice().sort((a, b) => a.id.localeCompare(b.id))
}

function replaceAt<T>(items: T[], index: number, value: T) {
  return [
    ...items.slice(0, index),
    value,
    ...items.slice(index + 1),
  ]
}

function messageIdFromEvent(event: Event) {
  const props = propertyRecord(event.properties)
  return text(props?.messageID) ??
    text(props?.messageId) ??
    text(propertyRecord(props?.info)?.id) ??
    text(propertyRecord(props?.part)?.messageID)
}

function partIdFromEvent(event: Event) {
  const props = propertyRecord(event.properties)
  return text(props?.partID) ??
    text(props?.partId) ??
    text(propertyRecord(props?.part)?.id)
}

function isOpencodePart(part: Part | MessagePart): part is Part {
  return "messageID" in part && "sessionID" in part
}

function propertyRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
