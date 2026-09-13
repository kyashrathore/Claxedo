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

/**
 * A grouped count, as the lookup a row reads. The query differs per adapter —
 * drizzle on SQLite, a prepared statement on D1 — but folding its rows does
 * not, and a task with no sessions has to read as zero rather than as absent.
 */
export function linkCountLookup(rows: readonly { taskId: string; links: number }[]) {
  const counts = new Map(rows.map((row) => [row.taskId, row.links]))
  return (taskId: string) => ({ count: counts.get(taskId) ?? 0 })
}

/**
 * Grouped child counts, as the lookup a row reads. A task with no children has
 * to read as `0/0` rather than as absent, the same way a task with no sessions
 * reads as zero.
 */
export function childCountLookup(rows: readonly { taskId: string; total: number; done: number }[]) {
  const counts = new Map(rows.map((row) => [row.taskId, { total: row.total, done: row.done }]))
  return (taskId: string) => counts.get(taskId) ?? { total: 0, done: 0 }
}

/**
 * The ids of the rows this page will show. The row past the limit only answers
 * "is there more", so counting its links would be a read nothing renders.
 */
export function tasksPageRows<Row>(rows: readonly Row[], limit: number): readonly Row[] {
  return rows.slice(0, limit)
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
