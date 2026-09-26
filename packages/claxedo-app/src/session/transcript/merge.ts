import type { AgentPresentationMessage } from "@claxedo/agent-runtime-contract"
import { readField, readString } from "@claxedo/helpers/readers"
import type { TranscriptMessage, TranscriptPart } from "@/server"
import type { PendingUserMessage, SessionMessage } from "./model"

export const isPresentationMessage = (info: TranscriptMessage): info is AgentPresentationMessage =>
  info.role === "user" || info.role === "assistant"

export const isPendingMessage = (message: SessionMessage): message is PendingUserMessage => "origin" in message

export type Found = { readonly found: boolean; readonly index: number }

export function searchById(list: readonly { readonly id: string }[], id: string): Found {
  let low = 0
  let high = list.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (list[mid].id < id) low = mid + 1
    else high = mid
  }
  return { found: low < list.length && list[low].id === id, index: low }
}

export function mergeSortedById<T extends { readonly id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const merged: T[] = []
  let a = 0
  let b = 0
  while (a < current.length || b < incoming.length) {
    const left = current[a]
    const right = incoming[b]
    if (right === undefined || (left !== undefined && left.id < right.id)) {
      merged.push(left as T)
      a += 1
    } else {
      merged.push(right)
      b += 1
      if (left !== undefined && left.id === right.id) a += 1
    }
  }
  return merged
}

function settledPart(part: TranscriptPart): boolean {
  const status = readString(readField(part, "state"), "status")
  if (status !== undefined) return status === "completed" || status === "error"
  return readField(readField(part, "time"), "end") !== undefined
}

export function mergedPart(current: TranscriptPart | undefined, next: TranscriptPart): TranscriptPart {
  return current && settledPart(current) && !settledPart(next) ? current : next
}

export function mergedMessage(current: SessionMessage | undefined, next: SessionMessage): SessionMessage {
  if (!current || isPendingMessage(current) || isPendingMessage(next)) return next
  if (current.role !== "assistant" || next.role !== "assistant") return next
  const completed = next.time.completed ?? current.time.completed
  const error = next.error ?? current.error
  if (completed === next.time.completed && error === next.error) return next
  return { ...next, time: { ...next.time, completed }, error }
}
