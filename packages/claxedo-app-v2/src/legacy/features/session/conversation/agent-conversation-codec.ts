/**
 * The two-way translation between the agent runtime contract's `Message`/`Part`
 * and TanStack's `UIMessage`/`MessagePart`.
 *
 * The chat handle speaks TanStack's types and the runtime speaks the contract's,
 * and neither union is a superset of the other: two contract part kinds
 * ("compaction", "agent") have no TanStack arm at all. This module is the only
 * place either shape is reinterpreted as the other — every conversion stashes
 * the canonical agent part under `metadata.agentPart` so the trip back is
 * lossless, and `partMetadata` is the single read-back. `agent-conversation.ts`
 * owns what happens to a conversation; this owns what its rows *are*.
 */
import type {
  AgentPresentationMessage as Message,
  AgentContentPart as Part,
  AgentToolState as ToolState,
} from "@claxedo/agent-runtime-contract"
import type { MessagePart, UIMessage } from "@tanstack/ai"
import { asRecord, readField, readString } from "@/lib/record"

export type ConversationUIMessage = UIMessage & {
  metadata?: {
    agentMessage?: Message
    optimistic?: boolean
  }
}

export type ConversationPartMetadata = {
  agentPartId?: string
  agentPart?: Part
  /** Set when this chat part stands in for a kind TanStack's union has no arm for. */
  carried?: CarriedPartKind
}

/**
 * The two part kinds the agent contract has and TanStack's `MessagePart` union
 * does not.
 *
 * `UIMessage.parts` is TanStack's own type, and none of its ten arms can hold a
 * "compaction" or "agent" part as itself. Both therefore ride the rail
 * "handoff" already uses — an empty text part whose metadata carries the
 * canonical agent part — with the kind named in `metadata.carried` so the trip
 * back reads it instead of guessing from `part.type`. `carriedMessagePart`
 * builds one, `carriedPartKind` reads it back, and no other site restates the
 * shape.
 */
export type CarriedPartKind =
  | { type: "compaction" }
  | { type: "agent"; name: string; source?: { value: string; start: number; end: number } }

export function carriedMessagePart(carried: CarriedPartKind, metadata: ConversationPartMetadata): MessagePart {
  return { type: "text", content: "", metadata: { ...metadata, carried } }
}

export function carriedPartKind(part: MessagePart): CarriedPartKind | undefined {
  const carried = readField(readField(part, "metadata"), "carried")
  const type = readString(carried, "type")
  if (type === "compaction") return { type: "compaction" }
  if (type !== "agent") return undefined
  const source = asRecord(readField(carried, "source"))
  return {
    type: "agent",
    name: readString(carried, "name") ?? "",
    ...(typeof source?.value === "string" && typeof source.start === "number" && typeof source.end === "number"
      ? { source: { value: source.value, start: source.start, end: source.end } }
      : {}),
  }
}

/** The agent message/part this adapter stashed on a chat part, read back. */
export function partMetadata(part: MessagePart): ConversationPartMetadata {
  const meta = asRecord(readField(part, "metadata"))
  const agentPart = meta?.agentPart
  const agentPartId = readString(meta, "agentPartId")
  const carried = carriedPartKind(part)
  return {
    ...(agentPartId === undefined ? {} : { agentPartId }),
    ...(isAgentPart(agentPart) ? { agentPart } : {}),
    ...(carried === undefined ? {} : { carried }),
  }
}

export function agentMessageToChatMessage(input: {
  message: Message
  parts: Array<Part | MessagePart>
}): UIMessage {
  return {
    id: input.message.id,
    role: input.message.role,
    createdAt: new Date(input.message.time.created),
    metadata: { agentMessage: input.message },
    parts: input.parts.flatMap((part) => isAgentPart(part) ? agentPartToChatParts(part) : [part]),
  } as UIMessage
}

export function agentPartToChatParts(part: Part): MessagePart[] {
  if (part.type === "text") {
    return [{
      type: "text",
      content: part.text,
      metadata: { agentPartId: part.id, agentPart: part },
    }]
  }
  if (part.type === "reasoning") {
    return [{
      type: "thinking",
      stepId: part.id,
      content: part.text,
      signature: typeof part.metadata?.signature === "string" ? part.metadata.signature : undefined,
      metadata: { agentPartId: part.id, agentPart: part },
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
        metadata: { agentPartId: part.id, agentPart: part, filename: part.filename },
      }]
    }
    return [{
      type: "document",
      source,
      metadata: { agentPartId: part.id, agentPart: part, filename: part.filename },
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
      metadata: { ...part.metadata, agentPartId: part.id, agentPart: part },
    }]
  }
  if ((part.type as string) === "handoff") {
    return [{
      // TanStack has no handoff part. Carry the canonical agent part on an
      // empty text envelope so it survives projection without rendering copy.
      type: "text",
      content: "",
      metadata: { agentPartId: part.id, agentPart: part },
    }]
  }
  // Compaction markers carry no payload beyond their type/id, and TanStack's
  // MessagePart union has no arm for them. Dropping them here silently hid the
  // assistant-timeline compaction divider (PART_MAPPING["compaction"]).
  if (part.type === "compaction") {
    return [carriedMessagePart({ type: "compaction" }, { agentPartId: part.id, agentPart: part })]
  }
  // @-mention parts, likewise absent from TanStack's union. The name and source
  // ride along beside the stashed original so a mention still round-trips when
  // no original was stored. Dropping this here silently hid mentions.
  if (part.type === "agent") {
    return [carriedMessagePart({
      type: "agent",
      name: part.name,
      ...(part.source ? { source: part.source } : {}),
    }, { agentPartId: part.id, agentPart: part })]
  }
  return []
}

export function agentPartId(part: MessagePart) {
  if (part.type === "thinking") return part.stepId
  return partMetadata(part).agentPartId
}

/**
 * A chat row this adapter never received from the runtime — an optimistic local
 * message shown before the server echo arrives. It is deliberately NOT an
 * `AgentPresentationMessage`: that contract requires `agent`, `model`/`modelID`,
 * `path`, `cost` and `tokens`, and inventing values for them would report
 * measurements that were never taken. Consumers narrow with
 * `isRuntimeAgentMessage` (or on the fields they need) instead of reading
 * through a cast.
 */
export type OptimisticAgentMessage = {
  /**
   * Names this arm, so `ProjectedAgentMessage` is a tagged union.
   *
   * Discriminating on a contract field the stub lacks (`agent`, required by both
   * `Message` arms) reads like a structural fact but is not one: the producers
   * that fill `metadata.agentMessage` are admitted on id/role/sessionID/time
   * alone (`isAgentMessage` here, `validMessageRow` in the message page), so a
   * runtime row that omitted `agent` would be misread as a stub and vanish from
   * the timeline. This tag is written by the single function that builds the
   * shape, so it cannot disagree with what the row is.
   */
  origin: "optimistic"
  id: string
  /**
   * The two roles a conversation row can hold. `UIMessage["role"]` is wider —
   * TanStack also carries transport roles this projection never renders — and
   * widening the stub past the presentation contract makes every consumer that
   * switches on `role` handle arms that cannot occur.
   */
  role: Message["role"]
  sessionID: string
  time: { created: number }
}

export type ProjectedAgentMessage = Message | OptimisticAgentMessage

/**
 * A user row the timeline can render: one the runtime produced, or the
 * optimistic stub standing in for it until the runtime echoes it back.
 *
 * The render path reads only `id`, `role`, `time` and the optional `summary`
 * off these — a turn's content comes from the projection's separate parts
 * record, keyed by `id`, which a stub has. Narrowing this to `AgentUserMessage`
 * would drop the just-typed message from the timeline for a round trip.
 */
export type ProjectedUserMessage =
  | Extract<Message, { role: "user" }>
  /**
   * `summary` is named as absent rather than left off: a property missing from
   * one arm is unreadable on the union, and the turn summary is written by the
   * runtime when the turn's snapshot lands, so a stub provably has none.
   */
  | (OptimisticAgentMessage & { role: "user"; summary?: undefined })

/** True for a projected row the runtime produced, not an optimistic local stub. */
export function isRuntimeAgentMessage(message: ProjectedAgentMessage): message is Message {
  return !("origin" in message)
}

export function chatMessageToAgentMessage(message: UIMessage): ProjectedAgentMessage {
  const stored = storedMessage(message)
  // The stored message keeps its own role: it is where the chat row's role came
  // from in the first place (`agentMessageToChatMessage`), and re-imposing
  // `UIMessage["role"]` here only widened it back off the contract's union.
  if (stored) {
    const created = message.createdAt?.getTime() ?? stored.time.created
    // Narrowed on the discriminant so each arm keeps its own `time` shape: an
    // unnarrowed spread widened both to `{created} | {created, completed?}`.
    return stored.role === "assistant"
      ? { ...stored, time: { ...stored.time, created } }
      : { ...stored, time: { created } }
  }
  // No stored agent message: a chat row this adapter never received from the
  // runtime (an optimistic local message before the server echo). Deliberately a
  // PARTIAL message — `AgentAssistantMessage` also requires `path`, `cost` and
  // `tokens`, and inventing zeroes for them would report measurements that were
  // never taken. Relabelling the row "user" to satisfy the other arm would be
  // worse still, so the stub is admitted as-is.
  return {
    origin: "optimistic",
    id: message.id,
    // TanStack's role union has a third arm, "system", that the presentation
    // contract has none for. Nothing here produces one — `agentMessageToChatMessage`
    // emits user and assistant only, and the composer creates user rows — and
    // folding the unreachable arm onto "assistant" keeps the one mistake that
    // would matter (a row the user did not type appearing as their own message)
    // impossible by construction.
    role: message.role === "user" ? "user" : "assistant",
    sessionID: "",
    time: { created: message.createdAt?.getTime() ?? 0 },
  } satisfies OptimisticAgentMessage
}

export function chatPartToAgentPart(message: UIMessage, part: MessagePart): Part[] {
  const metadata = partMetadata(part)
  const stored = metadata.agentPart
  if (stored && (stored.type as string) === "handoff") {
    return [{ ...stored, messageID: message.id }]
  }
  // A carried part rides an empty text envelope, so it has to be recognised
  // before the generic "text" branch below claims it. Reuse the stored original
  // when present (lossless); otherwise rebuild from what the carriage kept —
  // the path a freshly-composed message takes before the server echoes it.
  const carried = metadata.carried
  if (carried?.type === "compaction") {
    return [stored ? { ...stored, messageID: message.id } : {
      id: metadata.agentPartId ?? `${message.id}:compaction`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "compaction",
      auto: false,
    } as Part]
  }
  if (carried?.type === "agent") {
    return [stored ? { ...stored, messageID: message.id } : {
      id: metadata.agentPartId ?? `${message.id}:agent`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "agent",
      name: carried.name,
      ...(carried.source ? { source: carried.source } : {}),
    } as Part]
  }
  // The stored original is reused only when it is ALREADY this kind. Spreading a
  // stored part of another kind and overriding `type` carried that kind's fields
  // onto the new one — it typechecked only because the result was asserted.
  if (part.type === "text") {
    const base = stored?.type === "text" ? stored : undefined
    return [base ? {
      ...base,
      messageID: message.id,
      text: part.content,
    } : {
      id: metadata.agentPartId ?? `${message.id}:text`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "text",
      text: part.content,
    }]
  }
  if (part.type === "thinking") {
    const base = stored?.type === "reasoning" ? stored : undefined
    return [base ? {
      ...base,
      messageID: message.id,
      text: part.content,
    } : {
      id: part.stepId ?? `${message.id}:reasoning`,
      sessionID: chatMessageSessionId(message),
      messageID: message.id,
      type: "reasoning",
      text: part.content,
      time: { start: message.createdAt?.getTime() ?? 0 },
    }]
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
  return []
}

export function chatMessageSessionId(message: UIMessage) {
  const stored = (message as ConversationUIMessage).metadata?.agentMessage
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

/**
 * The agent contract's own part, as opposed to a TanStack `MessagePart`.
 *
 * Accepts `unknown` so the same predicate serves both the local discrimination
 * between the two part shapes and the event boundary, where `properties` is an
 * untyped SSE frame.
 */
export function isAgentPart(value: unknown): value is Part {
  const part = asRecord(value)
  return typeof part?.id === "string" && typeof part.type === "string"
    && typeof part.messageID === "string" && typeof part.sessionID === "string"
}

export function isAgentMessage(value: unknown): value is Message {
  const info = asRecord(value)
  return typeof info?.id === "string" && info.id.length > 0
    && (info.role === "user" || info.role === "assistant")
    && typeof info.sessionID === "string"
    && typeof asRecord(info.time)?.created === "number"
}

export function storedMessage(message: UIMessage | undefined) {
  return (message as ConversationUIMessage | undefined)?.metadata?.agentMessage
}
