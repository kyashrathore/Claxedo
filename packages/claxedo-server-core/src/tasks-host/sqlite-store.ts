/**
 * The desktop-local `TasksStorePort`, over the claxedo SQLite database.
 *
 * Ordering, seeking and limits are pushed into SQL rather than filtered in
 * memory, so a page boundary here is the same boundary the kit's reference
 * adapter produces on the same rows. Every predicate names `scope_id`, so a
 * row outside the caller's scope is unreachable rather than filtered out
 * afterwards.
 */
import { and, count, desc, eq, isNull, lt, ne, or } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import {
  taskSummaryOf,
  type ConfigurationSlot,
  type ListQuery,
  type Page,
  type TaskSummary,
  type TasksStoreOperations,
  type TasksStorePort,
} from "@claxedo/tasks"
import { tasksPage, tasksPageBounds } from "./paging"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import {
  linkColumns,
  linkOfColumns,
  presetColumns,
  presetOfColumns,
  receiptColumns,
  receiptOfColumns,
  taskColumns,
  taskOfColumns,
  type StoredTaskColumns,
} from "./stored-rows"
import {
  ClaxedoTaskCommandReceiptTable,
  ClaxedoTaskPresetTable,
  ClaxedoTaskSessionLinkTable,
  ClaxedoTaskTable,
} from "./tasks.sql"

/**
 * One list read as drizzle conditions: the rows the cursor has not passed yet,
 * newest first with the id as tie-break, and one row more than asked for so
 * "there is another page" is answered by the query rather than by a count.
 */
function windowConditions(query: ListQuery, createdAt: SQLiteColumn, id: SQLiteColumn) {
  const bounds = tasksPageBounds(query)
  const seek = bounds.cursor
    ? or(lt(createdAt, bounds.cursor.createdAt), and(eq(createdAt, bounds.cursor.createdAt), lt(id, bounds.cursor.id)))
    : undefined
  return { limit: bounds.limit, seek, order: [desc(createdAt), desc(id)] as const }
}

function taskSummaries(rows: readonly StoredTaskColumns[], limit: number): Page<TaskSummary> {
  return tasksPage(rows, limit, (row) => taskSummaryOf(taskOfColumns(row)))
}

function tasksOperations(): TasksStoreOperations {
  return {
    presets: {
      async get(scopeId, presetId) {
        const row = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskPresetTable)
            .where(and(eq(ClaxedoTaskPresetTable.scope_id, scopeId), eq(ClaxedoTaskPresetTable.preset_id, presetId)))
            .get(),
        )
        return row ? presetOfColumns(row) : undefined
      },

      async list(scopeId, ownerId, query) {
        const page = windowConditions(query, ClaxedoTaskPresetTable.created_at, ClaxedoTaskPresetTable.preset_id)
        const rows = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskPresetTable)
            .where(
              and(
                eq(ClaxedoTaskPresetTable.scope_id, scopeId),
                eq(ClaxedoTaskPresetTable.owner_id, ownerId),
                query.includeArchived ? undefined : isNull(ClaxedoTaskPresetTable.archived_at),
                page.seek,
              ),
            )
            .orderBy(...page.order)
            .limit(page.limit + 1)
            .all(),
        )
        return tasksPage(rows, page.limit, presetOfColumns)
      },

      async insert(preset) {
        ClaxedoDB.use((db) => db.insert(ClaxedoTaskPresetTable).values(presetColumns(preset)).run())
      },

      async update(preset, expectedRevision) {
        const written = ClaxedoDB.use((db) =>
          db
            .update(ClaxedoTaskPresetTable)
            .set(presetColumns(preset))
            .where(
              and(
                eq(ClaxedoTaskPresetTable.scope_id, preset.scopeId),
                eq(ClaxedoTaskPresetTable.preset_id, preset.id),
                eq(ClaxedoTaskPresetTable.revision, expectedRevision),
              ),
            )
            .returning({ presetId: ClaxedoTaskPresetTable.preset_id })
            .all(),
        )
        return written.length > 0
      },
    },

    tasks: {
      async get(scopeId, taskId) {
        const row = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskTable)
            .where(and(eq(ClaxedoTaskTable.scope_id, scopeId), eq(ClaxedoTaskTable.task_id, taskId)))
            .get(),
        )
        return row ? taskOfColumns(row) : undefined
      },

      async list(scopeId, query) {
        const page = windowConditions(query, ClaxedoTaskTable.created_at, ClaxedoTaskTable.task_id)
        const rows = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskTable)
            .where(
              and(
                eq(ClaxedoTaskTable.scope_id, scopeId),
                eq(ClaxedoTaskTable.project_id, query.projectId),
                query.includeArchived ? undefined : isNull(ClaxedoTaskTable.archived_at),
                query.status === null ? undefined : eq(ClaxedoTaskTable.status, query.status),
                query.parent === "root" ? isNull(ClaxedoTaskTable.parent_task_id) : undefined,
                page.seek,
              ),
            )
            .orderBy(...page.order)
            .limit(page.limit + 1)
            .all(),
        )
        return taskSummaries(rows, page.limit)
      },

      async listChildren(scopeId, parentTaskId, query) {
        const page = windowConditions(query, ClaxedoTaskTable.created_at, ClaxedoTaskTable.task_id)
        const rows = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskTable)
            .where(
              and(
                eq(ClaxedoTaskTable.scope_id, scopeId),
                eq(ClaxedoTaskTable.parent_task_id, parentTaskId),
                query.includeArchived ? undefined : isNull(ClaxedoTaskTable.archived_at),
                page.seek,
              ),
            )
            .orderBy(...page.order)
            .limit(page.limit + 1)
            .all(),
        )
        return taskSummaries(rows, page.limit)
      },

      async countChildren(scopeId, parentTaskId, filter) {
        const row = ClaxedoDB.use((db) =>
          db
            .select({ children: count() })
            .from(ClaxedoTaskTable)
            .where(
              and(
                eq(ClaxedoTaskTable.scope_id, scopeId),
                eq(ClaxedoTaskTable.parent_task_id, parentTaskId),
                filter.includeArchived ? undefined : isNull(ClaxedoTaskTable.archived_at),
                filter.excludeStatus === null ? undefined : ne(ClaxedoTaskTable.status, filter.excludeStatus),
              ),
            )
            .get(),
        )
        return row?.children ?? 0
      },

      async insert(task) {
        ClaxedoDB.use((db) => db.insert(ClaxedoTaskTable).values(taskColumns(task)).run())
      },

      async update(task, expectedRevision) {
        const written = ClaxedoDB.use((db) =>
          db
            .update(ClaxedoTaskTable)
            .set(taskColumns(task))
            .where(
              and(
                eq(ClaxedoTaskTable.scope_id, task.scopeId),
                eq(ClaxedoTaskTable.task_id, task.id),
                eq(ClaxedoTaskTable.revision, expectedRevision),
              ),
            )
            .returning({ taskId: ClaxedoTaskTable.task_id })
            .all(),
        )
        return written.length > 0
      },
    },

    links: {
      async getCurrent(scopeId, taskId, slot) {
        const row = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskSessionLinkTable)
            .where(slotScope(scopeId, taskId, slot))
            .orderBy(desc(ClaxedoTaskSessionLinkTable.attempt))
            .get(),
        )
        return row ? linkOfColumns(row) : undefined
      },

      async listByTask(scopeId, taskId) {
        const rows = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskSessionLinkTable)
            .where(and(eq(ClaxedoTaskSessionLinkTable.scope_id, scopeId), eq(ClaxedoTaskSessionLinkTable.task_id, taskId)))
            .orderBy(ClaxedoTaskSessionLinkTable.slot, desc(ClaxedoTaskSessionLinkTable.attempt))
            .all(),
        )
        return rows.map(linkOfColumns)
      },

      async insert(link) {
        const inserted = ClaxedoDB.use((db) =>
          db
            .insert(ClaxedoTaskSessionLinkTable)
            .values(linkColumns(link))
            .onConflictDoNothing()
            .returning({ sessionId: ClaxedoTaskSessionLinkTable.session_id })
            .all(),
        )
        if (inserted.length > 0) return { status: "inserted" }
        const stored = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskSessionLinkTable)
            .where(and(slotScope(link.scopeId, link.taskId, link.slot), eq(ClaxedoTaskSessionLinkTable.attempt, link.attempt)))
            .get(),
        )
        if (!stored) throw new Error(`Task session link ${link.taskId}/${link.slot}/${link.attempt} was refused and is absent`)
        return { status: "exists", link: linkOfColumns(stored) }
      },
    },

    receipts: {
      async get(scopeId, clientRequestId) {
        const row = ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoTaskCommandReceiptTable)
            .where(
              and(
                eq(ClaxedoTaskCommandReceiptTable.scope_id, scopeId),
                eq(ClaxedoTaskCommandReceiptTable.client_request_id, clientRequestId),
              ),
            )
            .get(),
        )
        return row ? receiptOfColumns(row) : undefined
      },

      async put(receipt) {
        const written = ClaxedoDB.use((db) =>
          db
            .insert(ClaxedoTaskCommandReceiptTable)
            .values(receiptColumns(receipt))
            .onConflictDoNothing()
            .returning({ clientRequestId: ClaxedoTaskCommandReceiptTable.client_request_id })
            .all(),
        )
        return written.length > 0
      },
    },
  }
}

function slotScope(scopeId: string, taskId: string, slot: ConfigurationSlot) {
  return and(
    eq(ClaxedoTaskSessionLinkTable.scope_id, scopeId),
    eq(ClaxedoTaskSessionLinkTable.task_id, taskId),
    eq(ClaxedoTaskSessionLinkTable.slot, slot),
  )
}

export function createSqliteTasksStore(): TasksStorePort {
  const operations = tasksOperations()
  // better-sqlite3 and bun:sqlite are both synchronous, so a unit cannot be
  // wrapped by the driver's own `transaction()` helper: the kit's work is an
  // async function and the helper would return before its first await
  // resolved. The statements are issued explicitly instead, and units are run
  // one at a time because a second BEGIN on the shared connection is an error,
  // not a nested transaction.
  let pending: Promise<unknown> = Promise.resolve()
  const unit = async <T>(work: (operations: TasksStoreOperations) => Promise<T>): Promise<T> => {
    const sqlite = ClaxedoDB.raw()
    sqlite.exec("BEGIN IMMEDIATE")
    try {
      const result = await work(operations)
      sqlite.exec("COMMIT")
      return result
    } catch (cause) {
      sqlite.exec("ROLLBACK")
      throw cause
    }
  }
  return {
    ...operations,
    transaction(work) {
      const run = () => unit(work)
      const settled = pending.then(run, run)
      pending = settled.then(
        () => undefined,
        () => undefined,
      )
      return settled
    },
  }
}
