/**
 * The desktop-local `TasksStorePort`, over the claxedo SQLite database.
 *
 * Ordering, seeking and limits are pushed into SQL rather than filtered in
 * memory, so a page boundary here is the same boundary the kit's reference
 * adapter produces on the same rows. Every predicate names `scope_id`, so a
 * row outside the caller's scope is unreachable rather than filtered out
 * afterwards.
 */
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import {
  serializedTransactions,
  type ConfigurationSlot,
  type ListQuery,
  type Task,
  type TasksStoreOperations,
  type TasksStorePort,
} from "@claxedo/tasks"
import { childCountLookup, linkCountLookup, taskSummaryPage, tasksPage, tasksPageBounds } from "./paging"
import { taskNumberTakenRefusal, tasksStoreConflict } from "./store-conflicts"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import {
  attachmentColumns,
  attachmentOfColumns,
  attachmentOfRow,
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
  ClaxedoTaskAttachmentTable,
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

/**
 * One grouped select for the whole page rather than one read per row, scoped by
 * `scope_id` as well as task: the primary key spans both, so a count that
 * dropped the scope would add another tenant's sessions to this row.
 */
function groupedLinkCounts(use: Reader, scopeId: string, taskIds: readonly string[]) {
  if (taskIds.length === 0) return linkCountLookup([])
  return linkCountLookup(
    use((db) =>
      db
        .select({ taskId: ClaxedoTaskSessionLinkTable.task_id, links: count() })
        .from(ClaxedoTaskSessionLinkTable)
        .where(
          and(
            eq(ClaxedoTaskSessionLinkTable.scope_id, scopeId),
            inArray(ClaxedoTaskSessionLinkTable.task_id, [...taskIds]),
          ),
        )
        .groupBy(ClaxedoTaskSessionLinkTable.task_id)
        .all(),
    ),
  )
}

/**
 * One grouped select over the whole page's children. Archived rows are excluded
 * from both numbers, so a parent whose only child was archived reads as having
 * none rather than as owing one it can never finish.
 */
function groupedChildCounts(use: Reader, scopeId: string, taskIds: readonly string[]) {
  if (taskIds.length === 0) return childCountLookup([])
  return childCountLookup(
    use((db) =>
      db
        .select({
          taskId: ClaxedoTaskTable.parent_task_id,
          total: count(),
          done: sql<number>`sum(case when ${ClaxedoTaskTable.status} = 'done' then 1 else 0 end)`,
        })
        .from(ClaxedoTaskTable)
        .where(
          and(
            eq(ClaxedoTaskTable.scope_id, scopeId),
            inArray(ClaxedoTaskTable.parent_task_id, [...taskIds]),
            isNull(ClaxedoTaskTable.archived_at),
          ),
        )
        .groupBy(ClaxedoTaskTable.parent_task_id)
        .all(),
    ).map((row) => ({ taskId: row.taskId ?? "", total: row.total, done: row.done ?? 0 })),
  )
}

function taskSummaries(use: Reader, scopeId: string, rows: readonly StoredTaskColumns[], limit: number) {
  return taskSummaryPage(rows, limit, async (taskIds) => ({
    links: groupedLinkCounts(use, scopeId, taskIds),
    children: groupedChildCounts(use, scopeId, taskIds),
  }))
}

type Reader = <T>(callback: (db: ClaxedoDB.Client) => T) => T

function tasksOperations(use: Reader): TasksStoreOperations {
  return {
    presets: {
      async get(scopeId, presetId) {
        const row = use((db) =>
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
        const rows = use((db) =>
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
        use((db) => db.insert(ClaxedoTaskPresetTable).values(presetColumns(preset)).run())
      },

      async update(preset, expectedRevision) {
        const written = use((db) =>
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

      // A unit here holds one WAL snapshot and promotes it at its first write,
      // so the read is the predicate: nothing else can have moved the row
      // behind a unit that goes on to commit.
      async assertRevision(scopeId, presetId, revision) {
        const row = use((db) =>
          db
            .select({ revision: ClaxedoTaskPresetTable.revision })
            .from(ClaxedoTaskPresetTable)
            .where(and(eq(ClaxedoTaskPresetTable.scope_id, scopeId), eq(ClaxedoTaskPresetTable.preset_id, presetId)))
            .get(),
        )
        return row?.revision === revision
      },
    },

    tasks: {
      async get(scopeId, taskId) {
        const row = use((db) =>
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
        const rows = use((db) =>
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
        return taskSummaries(use, scopeId, rows, page.limit)
      },

      async listChildren(scopeId, parentTaskId, query) {
        const page = windowConditions(query, ClaxedoTaskTable.created_at, ClaxedoTaskTable.task_id)
        const rows = use((db) =>
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
        return taskSummaries(use, scopeId, rows, page.limit)
      },

      async countChildren(scopeId, parentTaskId, filter) {
        const row = use((db) =>
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

      async nextNumber(scopeId, projectId) {
        const row = use((db) =>
          db
            .select({ highest: sql<number | null>`max(${ClaxedoTaskTable.number})` })
            .from(ClaxedoTaskTable)
            .where(and(eq(ClaxedoTaskTable.scope_id, scopeId), eq(ClaxedoTaskTable.project_id, projectId)))
            .get(),
        )
        return (row?.highest ?? 0) + 1
      },

      async insert(task) {
        try {
          use((db) => db.insert(ClaxedoTaskTable).values(taskColumns(task)).run())
        } catch (cause) {
          throw (
            (await tasksStoreConflict(
              [
                {
                  kind: "number-taken",
                  broken: async () =>
                    numberHolder(use, task)
                      ? taskNumberTakenRefusal(task.projectId, task.number)
                      : undefined,
                },
              ],
              cause,
            )) ?? cause
          )
        }
      },

      async update(task, expectedRevision) {
        const written = use((db) =>
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

    attachments: {
      async list(scopeId, taskId) {
        const rows = use((db) =>
          db
            .select(ATTACHMENT_COLUMNS)
            .from(ClaxedoTaskAttachmentTable)
            .where(attachmentScope(scopeId, taskId))
            .orderBy(asc(ClaxedoTaskAttachmentTable.position))
            .all(),
        )
        return rows.map((row) => attachmentOfColumns(row))
      },

      async get(scopeId, taskId, attachmentId) {
        const row = use((db) =>
          db
            .select()
            .from(ClaxedoTaskAttachmentTable)
            .where(and(attachmentScope(scopeId, taskId), eq(ClaxedoTaskAttachmentTable.attachment_id, attachmentId)))
            .get(),
        )
        return row ? attachmentOfRow(row) : undefined
      },

      async listWithBytes(scopeId, taskId) {
        const rows = use((db) =>
          db
            .select()
            .from(ClaxedoTaskAttachmentTable)
            .where(attachmentScope(scopeId, taskId))
            .orderBy(asc(ClaxedoTaskAttachmentTable.position))
            .all(),
        )
        return rows.map((row) => attachmentOfRow(row))
      },

      async insert(attachment) {
        const row = attachmentColumns(attachment)
        use((db) => db.insert(ClaxedoTaskAttachmentTable).values({ ...row, bytes: Buffer.from(attachment.bytes) }).run())
      },
    },

    links: {
      async getCurrent(scopeId, taskId, slot) {
        const row = use((db) =>
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
        const rows = use((db) =>
          db
            .select()
            .from(ClaxedoTaskSessionLinkTable)
            .where(and(eq(ClaxedoTaskSessionLinkTable.scope_id, scopeId), eq(ClaxedoTaskSessionLinkTable.task_id, taskId)))
            .orderBy(ClaxedoTaskSessionLinkTable.slot, desc(ClaxedoTaskSessionLinkTable.attempt))
            .all(),
        )
        return rows.map(linkOfColumns)
      },

      async bySession(scopeId, sessionId) {
        const row = use((db) =>
          db
            .select()
            .from(ClaxedoTaskSessionLinkTable)
            .where(
              and(eq(ClaxedoTaskSessionLinkTable.scope_id, scopeId), eq(ClaxedoTaskSessionLinkTable.session_id, sessionId)),
            )
            .get(),
        )
        return row ? linkOfColumns(row) : undefined
      },

      async listAgentStartedCloud(scopeId, projectId) {
        const rows = use((db) =>
          db
            .select({ link: ClaxedoTaskSessionLinkTable })
            .from(ClaxedoTaskSessionLinkTable)
            .innerJoin(
              ClaxedoTaskTable,
              and(
                eq(ClaxedoTaskTable.scope_id, ClaxedoTaskSessionLinkTable.scope_id),
                eq(ClaxedoTaskTable.task_id, ClaxedoTaskSessionLinkTable.task_id),
              ),
            )
            .where(
              and(
                eq(ClaxedoTaskSessionLinkTable.scope_id, scopeId),
                eq(ClaxedoTaskTable.project_id, projectId),
                eq(ClaxedoTaskSessionLinkTable.started_by, "agent"),
                eq(ClaxedoTaskSessionLinkTable.placement, "cloud"),
              ),
            )
            .orderBy(desc(ClaxedoTaskSessionLinkTable.created_at))
            .all(),
        )
        return rows.map((row) => linkOfColumns(row.link))
      },

      async insert(link) {
        const inserted = use((db) =>
          db
            .insert(ClaxedoTaskSessionLinkTable)
            .values(linkColumns(link))
            .onConflictDoNothing()
            .returning({ sessionId: ClaxedoTaskSessionLinkTable.session_id })
            .all(),
        )
        if (inserted.length > 0) return { status: "inserted" }
        const stored = use((db) =>
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
        const row = use((db) =>
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
        const written = use((db) =>
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

/** The task, other than this one, that holds this project's number — the whole of what the unique index refuses. */
function numberHolder(use: Reader, task: Task): string | undefined {
  const row = use((db) =>
    db
      .select({ taskId: ClaxedoTaskTable.task_id })
      .from(ClaxedoTaskTable)
      .where(
        and(
          eq(ClaxedoTaskTable.scope_id, task.scopeId),
          eq(ClaxedoTaskTable.project_id, task.projectId),
          eq(ClaxedoTaskTable.number, task.number),
          ne(ClaxedoTaskTable.task_id, task.id),
        ),
      )
      .get(),
  )
  return row?.taskId
}

/** Everything but the bytes, so a list read never loads an image it will not return. */
const ATTACHMENT_COLUMNS = {
  scope_id: ClaxedoTaskAttachmentTable.scope_id,
  task_id: ClaxedoTaskAttachmentTable.task_id,
  attachment_id: ClaxedoTaskAttachmentTable.attachment_id,
  position: ClaxedoTaskAttachmentTable.position,
  filename: ClaxedoTaskAttachmentTable.filename,
  mime: ClaxedoTaskAttachmentTable.mime,
  size: ClaxedoTaskAttachmentTable.size,
  created_at: ClaxedoTaskAttachmentTable.created_at,
}

function attachmentScope(scopeId: string, taskId: string) {
  return and(eq(ClaxedoTaskAttachmentTable.scope_id, scopeId), eq(ClaxedoTaskAttachmentTable.task_id, taskId))
}

function slotScope(scopeId: string, taskId: string, slot: ConfigurationSlot) {
  return and(
    eq(ClaxedoTaskSessionLinkTable.scope_id, scopeId),
    eq(ClaxedoTaskSessionLinkTable.task_id, taskId),
    eq(ClaxedoTaskSessionLinkTable.slot, slot),
  )
}

/**
 * Tasks reads and writes the claxedo database over a connection of its own,
 * one per database file.
 *
 * A unit of work holds `BEGIN` across awaits, and the shared `ClaxedoDB` handle
 * cannot carry that: a transaction open on it swallows every other module's
 * autocommitted write and rolls it back with the unit, and a `BEGIN` issued
 * while one is already open is an error rather than a nested unit. One
 * connection per file is also why this store is one object rather than a
 * factory: two store objects on two connections would each open a unit with
 * nothing arbitrating them, so there is exactly one, and `serializedTransactions`
 * queues every unit on it.
 *
 * `BEGIN DEFERRED`, not `IMMEDIATE`: the unit takes a WAL read snapshot and
 * promotes it at its first write, so a write from elsewhere in the process
 * commits and this unit refuses with SQLITE_BUSY_SNAPSHOT. `IMMEDIATE` would
 * instead hold the write lock for as long as the unit awaits, and every other
 * writer — synchronous, on this one thread — would block against it until
 * `busy_timeout` expired.
 */
let connected: { path: string; connection: ClaxedoDB.Connection } | undefined

function tasksConnection(): ClaxedoDB.Connection {
  const path = ClaxedoDB.Path()
  if (connected?.path === path) return connected.connection
  connected?.connection.close()
  connected = { path, connection: ClaxedoDB.connect() }
  return connected.connection
}

/**
 * A connection whose ROLLBACK fails is still inside the unit, and every later
 * BEGIN on it would fail too, so it is dropped and the next unit opens a fresh
 * one. What propagates is the failure that refused the unit, not the rollback's.
 */
function undo(connection: ClaxedoDB.Connection): void {
  try {
    connection.sqlite.exec("ROLLBACK")
  } catch {
    if (connected?.connection === connection) connected = undefined
    connection.close()
  }
}

const operations = tasksOperations((callback) => callback(tasksConnection().db))

const transaction = serializedTransactions(async (work) => {
  const connection = tasksConnection()
  connection.sqlite.exec("BEGIN DEFERRED")
  try {
    const result = await work(operations)
    connection.sqlite.exec("COMMIT")
    return result
  } catch (cause) {
    undo(connection)
    throw cause
  }
})

export const sqliteTasksStore: TasksStorePort = { ...operations, transaction }
