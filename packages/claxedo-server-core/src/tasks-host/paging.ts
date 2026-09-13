/**
 * The half of a Tasks list read that is the same on every durable adapter: how
 * many rows the caller may have, where the cursor left off, how a row set read
 * with one row to spare becomes a page and the cursor for the next one, and
 * how a page of task rows picks up its session and child counts.
 *
 * The seek itself is not here, nor are the count queries. SQLite expresses
 * those as drizzle conditions and D1 as SQL fragments, and folding them into
 * one shape would buy a shared name for two genuinely different expressions.
 */
import {
  clampLimit,
  decodePageCursor,
  encodePageCursor,
  taskSummaryOf,
  type ListQuery,
  type Page,
  type PageKey,
  type TaskSummary,
} from "@claxedo/tasks"
import { taskOfColumns, type StoredTaskColumns } from "./stored-rows"

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

export type TaskSummaryCounts = {
  links: (taskId: string) => { count: number }
  children: (taskId: string) => { total: number; done: number }
}

/**
 * A page of stored task rows as the summaries a caller reads.
 *
 * `counts` is asked only for the ids this page will show: the row past the
 * limit answers "is there more" and nothing renders it, so counting its
 * sessions and children would be two reads for a row the caller never sees.
 */
export async function taskSummaryPage(
  rows: readonly StoredTaskColumns[],
  limit: number,
  counts: (taskIds: readonly string[]) => Promise<TaskSummaryCounts>,
): Promise<Page<TaskSummary>> {
  const { links, children } = await counts(rows.slice(0, limit).map((row) => row.task_id))
  return tasksPage(rows, limit, (row) => taskSummaryOf(taskOfColumns(row), links(row.task_id), children(row.task_id)))
}
