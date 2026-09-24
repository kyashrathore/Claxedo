import { produce, type SetStoreFunction } from "solid-js/store"
import type { QueuedPrompt, TranscriptPage, TranscriptPart } from "@/server"
import { isPendingMessage, isPresentationMessage, mergeSortedById, mergedMessage, mergedPart, searchById } from "./merge"
import type { SessionMessage, TranscriptData } from "./model"

export type SetTranscript = SetStoreFunction<TranscriptData>

export const NO_PARTS: readonly TranscriptPart[] = Object.freeze([])

function pageMessages(page: TranscriptPage): SessionMessage[] {
  return page.entries.map((entry) => entry.info).filter(isPresentationMessage)
}

export function upsertMessage(set: SetTranscript, message: SessionMessage): void {
  set("messages", (messages) => {
    const { found, index } = searchById(messages, message.id)
    const next = messages.slice()
    next.splice(index, found ? 1 : 0, mergedMessage(found ? messages[index] : undefined, message))
    return next
  })
}

export function removeMessage(set: SetTranscript, messageId: string): void {
  set("messages", (messages) => {
    const { found, index } = searchById(messages, messageId)
    if (!found) return messages
    const next = messages.slice()
    next.splice(index, 1)
    return next
  })
  set(
    "parts",
    produce((parts) => {
      delete parts[messageId]
    }),
  )
}

export function upsertPart(set: SetTranscript, part: TranscriptPart): void {
  set("parts", part.messageID, (parts) => {
    const current = parts ?? []
    const index = current.findIndex((item) => item.id === part.id)
    const next = current.slice()
    next.splice(index < 0 ? next.length : index, index < 0 ? 0 : 1, mergedPart(index < 0 ? undefined : current[index], part))
    return next
  })
}

export function removePart(set: SetTranscript, messageId: string, partId: string): void {
  set("parts", messageId, (parts) => (parts ? parts.filter((part) => part.id !== partId) : parts))
}

export function appendDelta(set: SetTranscript, data: TranscriptData, messageId: string, partId: string, field: string, text: string): void {
  const index = data.parts[messageId]?.findIndex((part) => part.id === partId) ?? -1
  if (index < 0) return
  set(
    "parts",
    messageId,
    index,
    produce((part) => {
      const record = part as unknown as Record<string, unknown>
      const current = record[field]
      record[field] = typeof current === "string" ? current + text : text
    }),
  )
}

export function prependPage(set: SetTranscript, page: TranscriptPage): void {
  const older = pageMessages(page)
  set("messages", (messages) => mergeSortedById(older, messages))
  set(
    "parts",
    produce((parts) => {
      for (const entry of page.entries) parts[entry.info.id] = entry.parts.slice()
    }),
  )
}

export function replaceLatest(set: SetTranscript, page: TranscriptPage): void {
  const fresh = pageMessages(page)
  const fromId = fresh[0]?.id
  const freshIds = new Set(fresh.map((message) => message.id))
  const kept = new Set<string>()
  set("messages", (messages) => {
    const older = messages.filter((message) => isPendingMessage(message) || (fromId !== undefined && message.id < fromId))
    for (const message of older) kept.add(message.id)
    return mergeSortedById(older, fresh)
  })
  set(
    "parts",
    produce((parts) => {
      for (const id of Object.keys(parts)) if (!kept.has(id) && !freshIds.has(id)) delete parts[id]
      for (const entry of page.entries) parts[entry.info.id] = entry.parts.slice()
    }),
  )
}

export function dropQueuedStubs(set: SetTranscript, data: TranscriptData, queued: readonly QueuedPrompt[]): void {
  const queuedIds = new Set(queued.map((item) => item.messageId).filter((id): id is string => id !== undefined))
  if (queuedIds.size === 0) return
  if (!data.messages.some((message) => isPendingMessage(message) && queuedIds.has(message.id))) return
  set("messages", (messages) => messages.filter((message) => !(isPendingMessage(message) && queuedIds.has(message.id))))
}

export function lastUserMessageId(messages: readonly SessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].id
  }
  return undefined
}
