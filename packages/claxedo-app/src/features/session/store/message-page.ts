// Shared message-page normalization for the compat-session controller and
// DirectoryScope DataProvider hydration fallback.
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { message as clean } from "@/lib/diffs"

const SKIP_PART_TYPES = new Set(["patch", "step-start", "step-finish"])

export type MessageRow = {
  info?: Message
  parts?: Part[]
}

type ValidMessageRow = {
  info: Message
  parts?: Part[]
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
  return parts.filter((part) => !!part?.id)
}

export function storedMessageParts(parts: Part[]) {
  return sortMessageParts(parts.filter((part) => !SKIP_PART_TYPES.has(part.type)))
}

export function mergeStoredItems<T extends { id: string }>(existing: T[] | undefined, next: T[]) {
  if (!existing) return [...next]
  const merged = [...existing]
  const ids = new Set(existing.map((item) => item.id))
  let changed = false
  for (const item of next) {
    if (ids.has(item.id)) continue
    ids.add(item.id)
    merged.push(item)
    changed = true
  }
  if (!changed) return existing
  return merged
}

export function mergeParts(parts: Part[] | undefined, want: Part[]) {
  return mergeStoredItems(parts, sortMessageParts(want))
}

/**
 * Reconcile a message's stored parts against a CANONICAL payload — one that
 * describes the message's full current part set, not an increment.
 *
 * `mergeStoredItems` is a union: it adds ids and never removes them, because
 * its callers (streaming deltas, prepended history pages) each carry a
 * fragment of the truth and dropping anything absent from a fragment would
 * erase visible work. A canonical payload is different in kind — when the
 * server lists a message's parts, an id it does NOT list is an id that no
 * longer exists. Merging that as a union entrenches the stale id forever, and
 * since the timeline renders one row per part
 * (`message-timeline.data.ts`'s `groupParts`), an entrenched provisional
 * streaming part shows up as a second visible assistant row with the same
 * text — the duplicate-render bug in `live-real-harness-smoke.spec.ts`'s
 * HARNESS NOTES.
 *
 * The canonical payload wins on membership, order, and content. An empty list
 * is therefore authoritative too; failed or fragment reads never call this
 * function in the first place.
 *
 * Order follows the canonical payload rather than a sort of opaque ids: parts
 * do not arrive in lexical id order, and the server's order is the render
 * order.
 */
export function reconcileStoredParts(existing: Part[] | undefined, canonical: Part[]) {
  const next = canonical.filter((part) => !!part?.id)
  if (next.length === 0) return existing?.length ? next : (existing ?? next)
  if (!existing) return next
  const before = new Map(existing.map((part) => [part.id, part] as const))
  // Reuse the object we already hold wherever the canonical part is equal to
  // it, so row-level memos downstream keep their identity.
  const reconciled = next.map((part) => {
    const prior = before.get(part.id)
    return prior && samePart(prior, part) ? prior : part
  })
  // Nothing moved, vanished, appeared, or changed: hand back the SAME array so
  // reactive consumers see no update at all.
  const unchanged = existing.length === reconciled.length && reconciled.every((part, index) => existing[index] === part)
  return unchanged ? existing : reconciled
}

function samePart(a: Part, b: Part) {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

export function normalizeMessageRows(data: unknown) {
  const rows = messageRows(data).filter(validMessageRow)
  return {
    messages: rows.map((row) => clean(row.info)),
    parts: rows.map((row) => ({
      id: row.info.id,
      parts: storedMessageParts(row.parts ?? []),
    })),
  }
}
