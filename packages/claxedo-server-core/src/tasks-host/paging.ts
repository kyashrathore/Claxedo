/**
 * The half of a Tasks list read that is the same on every durable adapter: how
 * many rows the caller may have, where the cursor left off, and how a row set
 * read with one row to spare becomes a page and the cursor for the next one.
 *
 * The seek itself is not here. SQLite expresses it as drizzle conditions and
 * D1 as a SQL fragment, and folding those into one shape would buy a shared
 * name for two genuinely different expressions.
 */
import {
  clampLimit,
  decodePageCursor,
  encodePageCursor,
  type ListQuery,
  type Page,
  type PageKey,
} from "@claxedo/tasks"

export type TasksPageBounds = {
  limit: number
  /** Undefined for no cursor AND for a cursor this kit did not write, which is an unfiltered first page. */
  cursor: PageKey | undefined
}

export function tasksPageBounds(query: ListQuery): TasksPageBounds {
  return {
    limit: clampLimit(query.limit),
    cursor: query.cursor === null ? undefined : decodePageCursor(query.cursor),
  }
}

/** `rows` must have been read with `limit + 1`: the extra row is what says another page exists. */
export function tasksPage<Row, Item extends PageKey>(
  rows: readonly Row[],
  limit: number,
  item: (row: Row) => Item,
): Page<Item> {
  const items = rows.slice(0, limit).map(item)
  const last = items.at(-1)
  return { items, nextCursor: last && rows.length > limit ? encodePageCursor(last) : null }
}
