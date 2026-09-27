import { batch } from "solid-js"
import { produce, unwrap, type SetStoreFunction } from "solid-js/store"
import type { QueuedPrompt, TranscriptPage, TranscriptPart } from "@/server"
import type { ConversationMessage } from "@/transcript"
import { isOptimisticMessage, isPresentationMessage, mergeSortedById, mergedMessage, mergedPart, searchById } from "./merge"
import type { TranscriptData } from "./model"
import { partHasText, textIsPresent } from "@claxedo/agent-runtime-contract/turn-fold"

export type SetTranscript = SetStoreFunction<TranscriptData>

export const NO_PARTS: readonly TranscriptPart[] = Object.freeze([])

function markTextParts(set: SetTranscript, parts: readonly TranscriptPart[]): void {
  const present = parts.filter(partHasText)
  if (present.length === 0) return
  set(
    "partsWithText",
    produce((marked) => {
      for (const part of present) marked[part.id] = true
    }),
  )
}

function pageParts(page: TranscriptPage): TranscriptPart[] {
  return page.entries.flatMap((entry) => entry.parts)
}

function pageMessages(page: TranscriptPage): ConversationMessage[] {
  return page.entries.map((entry) => entry.info).filter(isPresentationMessage)
}

export function upsertMessage(set: SetTranscript, message: ConversationMessage): void {
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
  let stored = part
  set("parts", part.messageID, (parts) => {
    const current = parts ?? []
    const index = current.findIndex((item) => item.id === part.id)
    const next = current.slice()
    stored = mergedPart(index < 0 ? undefined : current[index], part)
    next.splice(index < 0 ? next.length : index, index < 0 ? 0 : 1, stored)
    return next
  })
  markTextParts(set, [stored])
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
  if (field === "text" && !data.partsWithText[partId] && textIsPresent(text)) set("partsWithText", partId, true)
}

function landedParts(current: readonly TranscriptPart[] | undefined, read: readonly TranscriptPart[]): TranscriptPart[] {
  const byId = new Map(current?.map((part) => [part.id, part]))
  return read.map((part) => mergedPart(byId.get(part.id), part))
}

export function prependPage(set: SetTranscript, page: TranscriptPage): void {
  const older = pageMessages(page)
  batch(() => {
    set("messages", (messages) => mergeSortedById(older, messages))
    set(
      "parts",
      produce((parts) => {
        for (const entry of page.entries) parts[entry.info.id] = landedParts(unwrap(parts[entry.info.id]), entry.parts)
      }),
    )
    markTextParts(set, pageParts(page))
  })
}

export function replaceLatest(set: SetTranscript, page: TranscriptPage): void {
  const fresh = pageMessages(page)
  const fromId = fresh[0]?.id
  const freshIds = new Set(fresh.map((message) => message.id))
  const kept = new Set<string>()
  batch(() => {
    set("messages", (messages) => {
      const older = messages.filter((message) => isOptimisticMessage(message) || (fromId !== undefined && message.id < fromId))
      for (const message of older) kept.add(message.id)
      return mergeSortedById(older, fresh)
    })
    set(
      "parts",
      produce((parts) => {
        for (const id of Object.keys(parts)) if (!kept.has(id) && !freshIds.has(id)) delete parts[id]
        for (const entry of page.entries) parts[entry.info.id] = landedParts(unwrap(parts[entry.info.id]), entry.parts)
      }),
    )
    markTextParts(set, pageParts(page))
  })
}

export function dropQueuedStubs(set: SetTranscript, data: TranscriptData, queued: readonly QueuedPrompt[]): void {
  const queuedIds = new Set(queued.map((item) => item.messageId).filter((id): id is string => id !== undefined))
  if (queuedIds.size === 0) return
  if (!data.messages.some((message) => isOptimisticMessage(message) && queuedIds.has(message.id))) return
  set("messages", (messages) => messages.filter((message) => !(isOptimisticMessage(message) && queuedIds.has(message.id))))
}

export function lastUserMessageId(messages: readonly ConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].id
  }
  return undefined
}
