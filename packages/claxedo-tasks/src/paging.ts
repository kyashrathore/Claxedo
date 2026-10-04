import { utf8ByteLength } from "@claxedo/helpers/string"
import { TASKS_BOUNDS, type ListQuery, type Page } from "./contracts"

/**
 * Every list is ordered newest first with the row id as tie-breaker, so two
 * rows written in the same millisecond keep a total order and a cursor can
 * never skip or repeat one.
 */
export type PageKey = {
  createdAt: number
  id: string
}

export function encodePageCursor(key: PageKey): string {
  return `${key.createdAt}:${key.id}`
}

/** Undefined for a value this module did not write, which pages from the start rather than refusing. */
export function decodePageCursor(value: string): PageKey | undefined {
  if (utf8ByteLength(value) > TASKS_BOUNDS.cursorMaxBytes) return undefined
  const separator = value.indexOf(":")
  if (separator <= 0) return undefined
  const createdAt = Number(value.slice(0, separator))
  const id = value.slice(separator + 1)
  if (!Number.isSafeInteger(createdAt) || id.length === 0) return undefined
  return { createdAt, id }
}

/** Negative when `left` sorts earlier in a page than `right`. */
function comparePageKeys(left: PageKey, right: PageKey): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
  if (left.id === right.id) return 0
  return left.id < right.id ? 1 : -1
}

function isAfterCursor(key: PageKey, cursor: PageKey): boolean {
  return comparePageKeys(key, cursor) > 0
}

export function clampLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return TASKS_BOUNDS.listLimitDefault
  return Math.min(limit, TASKS_BOUNDS.listLimitMax)
}

/**
 * Orders, seeks and slices an already-authorized row set. An adapter that can
 * push the same order into SQL should do that instead; this exists so every
 * adapter answers with the identical page boundaries.
 */
export function paginate<T extends PageKey>(rows: readonly T[], query: ListQuery): Page<T> {
  const limit = clampLimit(query.limit)
  const cursor = query.cursor === null ? undefined : decodePageCursor(query.cursor)
  const ordered = [...rows].sort(comparePageKeys)
  const seeked = cursor ? ordered.filter((row) => isAfterCursor(row, cursor)) : ordered
  const items = seeked.slice(0, limit)
  const last = items.at(-1)
  const nextCursor = last && seeked.length > items.length ? encodePageCursor(last) : null
  return { items, nextCursor }
}
