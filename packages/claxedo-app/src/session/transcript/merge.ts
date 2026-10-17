import type { AgentPresentationMessage } from "@claxedo/agent-runtime-contract"
import { readField, readString } from "@claxedo/helpers/readers"
import type { TranscriptMessage, TranscriptPart } from "@/server"
import type { ConversationMessage, OptimisticUserMessage } from "@/transcript"

export const isPresentationMessage = (info: TranscriptMessage): info is AgentPresentationMessage =>
  info.role === "user" || info.role === "assistant"

export const isOptimisticMessage = (message: ConversationMessage): message is OptimisticUserMessage => "origin" in message

export const isRuntimeMessage = (message: ConversationMessage): message is AgentPresentationMessage => !isOptimisticMessage(message)

export type TurnOrderKey = { readonly id: string; readonly created: number; readonly pending: boolean }

export function compareTurnOrder(left: TurnOrderKey, right: TurnOrderKey): number {
  if (left.pending !== right.pending) return left.pending ? 1 : -1
  if (left.created !== right.created) return left.created - right.created
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export const messageOrderKey = (message: ConversationMessage): TurnOrderKey => ({
  id: message.id,
  created: message.time.created,
  pending: isOptimisticMessage(message),
})

export const messageOrder = (left: ConversationMessage, right: ConversationMessage): number =>
  compareTurnOrder(messageOrderKey(left), messageOrderKey(right))

export function indexOfMessage(list: readonly { readonly id: string }[], id: string): number {
  return list.findIndex((message) => message.id === id)
}

export function insertionIndex(list: readonly ConversationMessage[], message: ConversationMessage): number {
  let low = 0
  let high = list.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (messageOrder(list[mid], message) < 0) low = mid + 1
    else high = mid
  }
  return low
}

export function mergeInOrder(current: readonly ConversationMessage[], incoming: readonly ConversationMessage[]): ConversationMessage[] {
  const replaced = new Set(incoming.map((message) => message.id))
  return [...current.filter((message) => !replaced.has(message.id)), ...incoming].sort(messageOrder)
}

function settledPart(part: TranscriptPart): boolean {
  const status = readString(readField(part, "state"), "status")
  if (status !== undefined) return status === "completed" || status === "error"
  return readField(readField(part, "time"), "end") !== undefined
}

function keepsLoadedBody(current: TranscriptPart, next: TranscriptPart): boolean {
  return current.type === "tool" && next.type === "tool" && next.headerOnly === true && current.headerOnly !== true && current.state.status === next.state.status
}

export function mergedPart(current: TranscriptPart | undefined, next: TranscriptPart): TranscriptPart {
  if (!current) return next
  return (settledPart(current) && !settledPart(next)) || keepsLoadedBody(current, next) ? current : next
}

export function mergedMessage(current: ConversationMessage | undefined, next: ConversationMessage): ConversationMessage {
  if (!current || isOptimisticMessage(current) || isOptimisticMessage(next)) return next
  if (current.role !== "assistant" || next.role !== "assistant") return next
  const completed = next.time.completed ?? current.time.completed
  const error = next.error ?? current.error
  if (completed === next.time.completed && error === next.error) return next
  return { ...next, time: { ...next.time, completed }, error }
}
