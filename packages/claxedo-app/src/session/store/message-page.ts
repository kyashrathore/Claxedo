// Shared message-page normalization for the compat-session controller and
// DirectoryScope DataProvider hydration fallback.
import { Binary } from "@claxedo/utils/binary"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { message as clean } from "@/utils/diffs"

const SKIP_PART_TYPES = new Set(["patch", "step-start", "step-finish"])

export type MessageRow = {
  info?: Message
  parts?: Part[]
}

type ValidMessageRow = {
  info: Message
  parts?: Part[]
}

export function compareIDs(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

export function messageRows(data: unknown) {
  if (Array.isArray(data)) return data as MessageRow[]
  if (!data || typeof data !== "object") return []
  const value = (data as { messages?: unknown }).messages
  if (!Array.isArray(value)) return []
  return value as MessageRow[]
}

function validMessageRow(row: MessageRow): row is ValidMessageRow {
  return !!row?.info?.id
}

export function sortMessageParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => compareIDs(a.id, b.id))
}

export function storedMessageParts(parts: Part[]) {
  return sortMessageParts(parts.filter((part) => !SKIP_PART_TYPES.has(part.type)))
}

export function mergeStoredItems<T extends { id: string }>(existing: T[] | undefined, next: T[]) {
  if (!existing) return [...next].sort((a, b) => compareIDs(a.id, b.id))
  const merged = [...existing].sort((a, b) => compareIDs(a.id, b.id))
  let changed = false
  for (const item of next) {
    const result = Binary.search(merged, item.id, (value) => value.id)
    if (result.found) {
      const current = merged[result.index]!
      const replacement = mergeStoredItem(current, item)
      if (replacement === current) continue
      merged[result.index] = replacement
      changed = true
      continue
    }
    merged.splice(result.index, 0, item)
    changed = true
  }
  if (!changed) return existing
  return merged
}

function mergeStoredItem<T extends { id: string }>(current: T, next: T) {
  if (storedText(next).length < storedText(current).length) return current
  return sameStoredItem(current, next) ? current : next
}

function storedText(input: unknown) {
  const value = input as { text?: unknown }
  return typeof value.text === "string" ? value.text : ""
}

function sameStoredItem(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

export function mergeParts(parts: Part[] | undefined, want: Part[]) {
  return mergeStoredItems(parts, sortMessageParts(want))
}

export function normalizeMessageRows(data: unknown) {
  const rows = messageRows(data).filter(validMessageRow).sort((a, b) => compareIDs(a.info.id, b.info.id))
  return {
    messages: rows.map((row) => clean(row.info)),
    parts: rows.map((row) => ({
      id: row.info.id,
      parts: storedMessageParts(row.parts ?? []),
    })),
  }
}
