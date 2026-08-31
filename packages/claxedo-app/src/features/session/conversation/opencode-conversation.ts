import type { Event, Message, Part, ToolState } from "@opencode-ai/sdk/v2/client"
export type { Message } from "@opencode-ai/sdk/v2/client"
import type { MessagePart, UIMessage } from "@tanstack/ai"
import { preserveMessageFields, withPreservedAuthor } from "./conversation-snapshot"

export type ConversationChatHandle = {
  messages: () => UIMessage[]
  setMessages: (messages: UIMessage[]) => void
}

type ConversationUIMessage = UIMessage & {
  metadata?: {
    opencodeMessage?: Message
    optimistic?: boolean
  }
}

// A live event can outrun a REST snapshot that started before it. This marker is
// deliberately process-local (WeakSet, not persisted metadata): it protects the
// event only until a canonical row confirms/replaces it, and cannot make a stale
// row immortal after reload.
const unpersistedLiveMessages = new WeakSet<UIMessage>()

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

export type ConversationSnapshotMergeOptions = {
  order?: "snapshot"
  /** The caller has already resolved the desired server-backed membership. */
  membership?: "resolved"
  /** Message envelopes that came from a complete producer row. */
  canonicalMessageIDs?: ReadonlySet<string>
  /** Messages whose complete persisted part list is authoritative, including []. */
  canonicalPartMessageIDs?: ReadonlySet<string>
}

export function mergeConversationSnapshot(current: UIMessage[], snapshot: UIMessage[], options?: ConversationSnapshotMergeOptions) {
  const merged = [...current]
  const distinctSnapshotReplies = distinctAssistantSnapshotReplies(snapshot)
  // Index once: the per-message `assistantTurnIndex` linear scan made a full
  // hydrate O(n²) over the conversation (a 400-turn session pays ~640k
  // comparisons per refetch). The map serves the same two id lookups; the
  // rare announced-envelope candidate scan keeps its original semantics.
  const indexById = new Map<string, number>()
  merged.forEach((item, index) => indexById.set(item.id, index))
  let changed = false
  for (const message of snapshot) {
    // Same turn-aware match the event path uses: a reply can arrive under the
    // announced `${parentID}_r` id or under the id the engine chose, and filing
    // those as two messages renders the turn twice (and splits its parts
    // between the halves). See `assistantTurnIndex`.
    const index = assistantTurnIndex(
      merged,
      storedMessage(message) ?? ({ id: message.id, role: message.role } as Message),
      indexById,
      options?.canonicalMessageIDs,
      distinctSnapshotReplies,
    )
    if (index === -1) {
      indexById.set(message.id, merged.length)
      merged.push(message)
      changed = true
      continue
    }
    const existing = merged[index]!
    // Snapshot refetches mostly re-deliver identical settled content. Compare
    // one message at a time so unchanged rows preserve their object identity,
    // while equal-length text changes and same-rank tool updates still reach
    // the authoritative merge path.
    if (unchangedSnapshotMessage(existing, message)) continue
    if (existing.id !== message.id) {
      indexById.delete(existing.id)
      indexById.set(message.id, index)
    }
    const canonicalMessage = options?.canonicalMessageIDs?.has(message.id) === true
    const next = mergeChatMessage(existing, message, {
      canonicalMessage,
      canonicalParts: options?.canonicalPartMessageIDs?.has(message.id) === true,
    })
    // A projected fragment confirms neither persistence nor membership. Keep a
    // newer event's transient protection until a canonical row replaces it.
    merged[index] = !canonicalMessage && unpersistedLiveMessages.has(existing)
      ? markUnpersistedLive(next)
      : next
    changed = true
  }
  if (options?.order !== "snapshot") return changed ? merged : current
  const byID = new Map(merged.map((message) => [message.id, message] as const))
  const ordered = snapshot.flatMap((message) => {
    const value = byID.get(message.id)
    return value ? [value] : []
  })
  const snapshotIDs = new Set(snapshot.map((message) => message.id))
  const omitted = merged.filter((message) =>
    !snapshotIDs.has(message.id) &&
    (options?.membership !== "resolved" || retainOutsideCanonicalSnapshot(message)))
  const result = [...ordered, ...omitted]
  return result.length === current.length && result.every((message, index) => current[index] === message) ? current : result
}

/**
 * The runtime can use the announced `${parentID}_r` envelope for an
 * intermediate tool step and then persist a separate final assistant message.
 * When one producer snapshot explicitly contains both, their membership is
 * authoritative: they are two messages, not the live/canonical aliases that
 * `assistantTurnIndex` normally reconciles across separate observations.
 */
function distinctAssistantSnapshotReplies(snapshot: UIMessage[]) {
  const byParent = new Map<string, string[]>()
  for (const item of snapshot) {
    const message = storedMessage(item)
    if (message?.role !== "assistant" || typeof message.parentID !== "string") continue
    const ids = byParent.get(message.parentID)
    if (ids) ids.push(message.id)
    else byParent.set(message.parentID, [message.id])
  }
  const distinct = new Set<string>()
  for (const [parentID, ids] of byParent) {
    if (ids.length < 2 || !ids.includes(`${parentID}_r`)) continue
    ids.forEach((id) => distinct.add(id))
  }
  return distinct
}

/**
 * True when the fetched snapshot message cannot differ from what is already
 * merged: same canonical message and pairwise-equal canonical parts. A
 * snapshot must also replace optimistic metadata even when its visible content
 * is identical. Conservative — missing/cyclic canonical data falls through to
 * the full merge.
 */
function unchangedSnapshotMessage(existing: UIMessage, snapshot: UIMessage): boolean {
  if (existing.id !== snapshot.id) return false
  if (pendingConversationMessage(existing) || pendingConversationMessage(snapshot)) return false
  const storedExisting = storedMessage(existing)
  const storedSnapshot = storedMessage(snapshot)
  if (!storedExisting || !storedSnapshot) return false
  if (!sameSerializableValue(storedExisting, storedSnapshot)) return false
  const timeSnapshot = storedSnapshot.time as { completed?: number } | undefined
  if (storedSnapshot.role === "assistant") {
    if (typeof timeSnapshot?.completed !== "number") return false
  }
  if (existing.parts.length !== snapshot.parts.length) return false
  for (let index = 0; index < snapshot.parts.length; index++) {
    const left = existing.parts[index]!
    const right = snapshot.parts[index]!
    if (!sameSerializableValue(left, right)) return false
  }
  return true
}

function pendingConversationMessage(message: UIMessage) {
  const metadata = (message as ConversationUIMessage).metadata
  return metadata?.optimistic === true || unpersistedLiveMessages.has(message)
}

function retainOutsideCanonicalSnapshot(message: UIMessage) {
  const metadata = (message as ConversationUIMessage).metadata
  return metadata?.optimistic === true || unpersistedLiveMessages.has(message)
}

function sameSerializableValue(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
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

function storedMessage(message: UIMessage | undefined) {
  return (message as ConversationUIMessage | undefined)?.metadata?.opencodeMessage
}

function mergeChatMessage(
  current: UIMessage,
  snapshot: UIMessage,
  authority?: { canonicalMessage?: boolean; canonicalParts?: boolean },
): UIMessage {
  const preserved = storedMessage(snapshot)
  if (preserved) {
    // Always keep signed author chips across engine envelopes (including
    // canonical REST rows that omit `claxedo.author`). Error preservation is
    // skipped for canonical assistant rows so a settled transcript can clear
    // a transient failure — preserveMessageFields still ranks errors when
    // both sides are non-canonical.
    const merged = authority?.canonicalMessage && preserved.role === "assistant"
      ? withPreservedAuthor(storedMessage(current), preserved)
      : preserveMessageFields(storedMessage(current), preserved)
    if (merged !== preserved) {
      const meta = (snapshot as ConversationUIMessage).metadata
      snapshot = { ...snapshot, metadata: { ...meta, opencodeMessage: merged } } as UIMessage
    }
  }
  // Only a producer-marked canonical part list can remove omitted parts.
  // A latest-surface response can contain a settled message while still being
  // a fragment of the turn; treating settlement alone as completeness briefly
  // deletes intermediate task/tool parts before latest-turn hydration lands.
  if (authority?.canonicalParts) return snapshot
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
  if (current.type === "tool-call" && snapshot.type === "tool-call") {
    return toolCallStateRank(snapshot.state) >= toolCallStateRank(current.state) ? snapshot : current
  }
  if (
    (current.type === "text" || current.type === "thinking") &&
    snapshot.type === current.type &&
    textContent(snapshot).length >= textContent(current).length
  ) {
    return snapshot
  }
  return current
}

function toolCallStateRank(state: string | undefined) {
  if (state === "complete") return 2
  if (state === "input-complete") return 1
  return 0
}

function textContent(part: MessagePart) {
  if (part.type === "text" || part.type === "thinking") return part.content ?? ""
  return ""
}

function upsertMessage(chat: ConversationChatHandle, message: Message | undefined) {
  if (!message?.id) return false
  const current = chat.messages()
  const index = assistantTurnIndex(current, message)
  const existing = index === -1 ? undefined : current[index]
  const next = markUnpersistedLive(opencodeMessageToChatMessage({
    // A later event carrying a thinner error must not downgrade what the card
    // already rendered for this turn. Same for signed author chips: engine
    // envelopes omit `claxedo.author` and must not erase the host stamp.
    message: preserveMessageFields(storedMessage(existing), message),
    parts: existing?.parts ?? [],
  }))
  chat.setMessages(index === -1 ? [...current, next] : replaceAt(current, index, next))
  return true
}

/**
 * Where an incoming message belongs in the store — by id, or, for an assistant
 * message, by the TURN it answers.
 *
 * A turn's reply can arrive under two different ids. The adapter announces the
 * turn as `${userMessageId}_r` so the reply has a stable id before the engine
 * has chosen one; the engine then emits its own envelope for that same reply
 * under an id it generated. Keying purely on id filed those as two messages,
 * and since the timeline renders one row per assistant message, the reply
 * rendered TWICE.
 *
 * Worse, the two envelopes split the turn's state between them: the parts
 * attach to whichever id the part events carry, leaving the other envelope
 * empty. That is the same defect seen from the other side — a turn whose reply
 * exists on the wire but renders as an empty row, with the composer never
 * settling because the turn it is tracking is the half without content.
 *
 * Matching is deliberately narrow, and keys on the ANNOUNCED id specifically:
 * the two envelopes are collapsed only when one of them is literally
 * `${parentID}_r`, the id the adapter announces. Matching on shared `parentID`
 * alone is too loose — a turn can legitimately hold several assistant messages
 * under one parent (a continued turn, a follow-up step), and collapsing those
 * would silently lose a real message. The `_r` convention is what makes "these
 * two are the same reply" a fact rather than a guess.
 */
function assistantTurnIndex(
  current: UIMessage[],
  message: Message,
  indexById?: Map<string, number>,
  canonicalMessageIDs?: ReadonlySet<string>,
  distinctSnapshotReplies?: ReadonlySet<string>,
) {
  const byId = indexById ? (indexById.get(message.id) ?? -1) : current.findIndex((item) => item.id === message.id)
  if (byId !== -1) return byId
  if (distinctSnapshotReplies?.has(message.id)) return -1
  if (message.role !== "assistant") return -1
  const parentID = (message as { parentID?: unknown }).parentID
  if (typeof parentID !== "string" || !parentID) return -1
  const announced = `${parentID}_r`
  const aliasIndex = (index: number) =>
    index !== -1 && assistantTaskStep(current[index]) ? -1 : index
  // Either the incoming message IS the announced envelope and the engine's
  // arrived first, or vice versa. Anything else is a genuinely separate message.
  if (message.id === announced) {
    const candidates = current.flatMap((item, index) => {
      const stored = storedMessage(item)
      return stored?.role === "assistant" && (stored as { parentID?: unknown }).parentID === parentID
        && !(canonicalMessageIDs?.has(message.id) && canonicalMessageIDs.has(stored.id))
        ? [index]
        : []
    })
    return candidates.length === 1 ? aliasIndex(candidates[0]!) : -1
  }
  return aliasIndex(indexById ? (indexById.get(announced) ?? -1) : current.findIndex((item) => item.id === announced))
}

function assistantTaskStep(message: UIMessage | undefined) {
  return message?.parts.some((part) => part.type === "tool-call" && part.name === "task") === true
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
  chat.setMessages(replaceAt(current, index, markUnpersistedLive({
    ...message,
    parts: upsertChatParts(message.parts, part.id, mapped),
  })))
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
  chat.setMessages(replaceAt(current, index, markUnpersistedLive({
    ...message,
    parts: nextParts,
  })))
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
  chat.setMessages(replaceAt(current, index, markUnpersistedLive({
    ...message,
    parts: appendTextDelta(message.parts, partID, delta),
  })))
  return true
}

function markUnpersistedLive(message: UIMessage): UIMessage {
  unpersistedLiveMessages.add(message)
  return message
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
  if ((part.type as string) === "handoff") {
    return [{
      // TanStack has no handoff part. Carry the canonical OpenCode part on an
      // empty text envelope so it survives projection without rendering copy.
      type: "text",
      content: "",
      metadata: { opencodePartId: part.id, opencodePart: part },
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
  if (stored && (stored.type as string) === "handoff") {
    return [{ ...stored, messageID: message.id }]
  }
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
