/**
 * The position in a runtime's event feed a response was taken at, so a reader
 * can tell whether the live stream it holds covers everything a read did not
 * include. A read answers the position its snapshot is good up to; an event
 * stream answers the position it starts after. The stream covers the read
 * when both come from the same feed and the stream starts no later than the
 * read: nothing then fell between the two.
 *
 * `feed` identifies one runtime process's numbering; a position from another
 * feed is not comparable, so a reader treats the pair as uncovered.
 */
export const EVENT_CURSOR_HEADER = "X-Event-Cursor"

export type EventCursor = { readonly feed: string; readonly at: number }

const CURSOR_SEPARATOR = "."

export function formatEventCursor(cursor: EventCursor): string {
  return `${cursor.feed}${CURSOR_SEPARATOR}${cursor.at}`
}

export function parseEventCursor(value: string | null | undefined): EventCursor | undefined {
  const separator = value?.lastIndexOf(CURSOR_SEPARATOR) ?? -1
  if (!value || separator <= 0) return undefined
  const at = Number(value.slice(separator + 1))
  return Number.isSafeInteger(at) && at >= 0 ? { feed: value.slice(0, separator), at } : undefined
}

export function eventCursorCovers(streamSince: EventCursor | undefined, readAt: EventCursor | undefined): boolean {
  return streamSince !== undefined && readAt !== undefined && streamSince.feed === readAt.feed && streamSince.at <= readAt.at
}
