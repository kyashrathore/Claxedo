/**
 * The hosted `TasksStorePort`, over D1, partitioned to one organization.
 *
 * D1 has no interactive transaction. A unit of work therefore reads committed
 * rows (plus whatever the unit itself has already written), collects its
 * statements, and commits them with one `batch` — D1 runs a batch inside a
 * single transaction, so either every statement lands or none does.
 *
 * What a batch cannot do on its own is notice that a row moved between the
 * read that decided a write and the write itself: an `update ... where
 * revision = ?` that matches nothing changes nothing and reports no error, so
 * the unit's other statements would commit around a lost update. A guarded
 * write is therefore preceded in the same batch by a statement that inserts
 * into `task_write_guards` exactly when its predicate has stopped holding, and
 * that insert refuses, which rolls the whole batch back.
 *
 * A refused batch names no statement, and by then every operation in the unit
 * has already reported success — so each queued predicate also carries the
 * read that says whether it is the one that broke, and the unit rejects with a
 * `TasksStoreConflict` naming it. A duplicate command receipt is the answer a
 * caller replays; a moved revision or a claimed session origin is the answer it
 * refuses.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import {
  TASKS_STORE_CONFLICTS,
  TasksStoreConflict,
  taskSummaryOf,
  type ConfigurationSlot,
  type ListQuery,
  type Preset,
  type Task,
  type TaskSessionLink,
  type TasksCommandReceipt,
  type TasksStoreConflictKind,
  type TasksStoreOperations,
  type TasksStorePort,
} from "@claxedo/tasks"
import {
  linkColumns,
  linkOfColumns,
  presetColumns,
  presetOfColumns,
  receiptColumns,
  receiptOfColumns,
  taskColumns,
  taskOfColumns,
  type StoredLinkColumns,
  type StoredPresetColumns,
  type StoredReceiptColumns,
  type StoredTaskColumns,
} from "@claxedo/server-core/tasks-host/stored-rows"
import {
  linkCountLookup,
  tasksPage,
  tasksPageBounds,
  tasksPageRows,
} from "@claxedo/server-core/tasks-host/paging"

export type D1TasksStoreInput = Readonly<{ database: D1Database }>

const PRESET_COLUMNS =
  "scope_id, preset_id, revision, owner_id, name, instructions, execution, configurations, archived_at, created_at, updated_at"
const TASK_COLUMNS =
  "scope_id, task_id, revision, project_id, workspace_id, parent_task_id, title, description, status, child_set_revision, archived_at, created_at, updated_at"
const LINK_COLUMNS =
  "scope_id, task_id, slot, attempt, session_id, session_workspace_id, continued_from_session_id, continued_from_workspace_id, preset_id, preset_revision, preset_name_at_start, configuration_digest, handoff_text, created_at"
const RECEIPT_COLUMNS = "scope_id, client_request_id, command_name, request_hash, result, created_at"

function presetValues(preset: Preset): unknown[] {
  const row = presetColumns(preset)
  return [
    row.scope_id,
    row.preset_id,
    row.revision,
    row.owner_id,
    row.name,
    row.instructions,
    row.execution,
    row.configurations,
    row.archived_at,
    row.created_at,
    row.updated_at,
  ]
}

function taskValues(task: Task): unknown[] {
  const row = taskColumns(task)
  return [
    row.scope_id,
    row.task_id,
    row.revision,
    row.project_id,
    row.workspace_id,
    row.parent_task_id,
    row.title,
    row.description,
    row.status,
    row.child_set_revision,
    row.archived_at,
    row.created_at,
    row.updated_at,
  ]
}

/**
 * One prepared statement for a whole page of tasks. The primary key spans scope
 * and task, so the scope is bound too: without it a task id reused in another
 * tenant would add its sessions to this row.
 */
async function preparedLinkCounts(database: D1Database, scopeId: string, taskIds: readonly string[]) {
  if (taskIds.length === 0) return linkCountLookup([])
  const placeholders = taskIds.map(() => "?").join(", ")
  const rows = await database
    .prepare(
      `select task_id, count(*) as links from task_session_links where scope_id = ? and task_id in (${placeholders})` +
        ` group by task_id`,
    )
    .bind(scopeId, ...taskIds)
    .all<{ task_id: string; links: number }>()
  return linkCountLookup(rows.results.map((row) => ({ taskId: row.task_id, links: row.links })))
}

function linkValues(link: TaskSessionLink): unknown[] {
  const row = linkColumns(link)
  return [
    row.scope_id,
    row.task_id,
    row.slot,
    row.attempt,
    row.session_id,
    row.session_workspace_id,
    row.continued_from_session_id,
    row.continued_from_workspace_id,
    row.preset_id,
    row.preset_revision,
    row.preset_name_at_start,
    row.configuration_digest,
    row.handoff_text,
    row.created_at,
  ]
}

function receiptValues(receipt: TasksCommandReceipt): unknown[] {
  const row = receiptColumns(receipt)
  return [row.scope_id, row.client_request_id, row.command_name, row.request_hash, row.result, row.created_at]
}

function insertStatement(table: string, columns: string, values: readonly unknown[]): string {
  return `insert into ${table} (${columns}) values (${values.map(() => "?").join(", ")})`
}

/**
 * The `set` half of an update: every column but the key ones, paired with the
 * value that column was bound to, so one column list serves the insert and the
 * update and the two cannot drift apart.
 */
function assignment(columns: string, keys: readonly string[], values: readonly unknown[]) {
  const assigned = columns
    .split(", ")
    .map((column, index) => ({ column, value: values[index] }))
    .filter((entry) => !keys.includes(entry.column))
  return {
    clause: assigned.map((entry) => `${entry.column} = ?`).join(", "),
    values: assigned.map((entry) => entry.value),
  }
}

/** The rows a unit has written but not yet committed, so it reads its own writes back. */
type Overlay = {
  presets: Map<string, Preset>
  tasks: Map<string, Task>
  links: Map<string, TaskSessionLink>
  receipts: Map<string, TasksCommandReceipt>
}

/**
 * How one statement in the batch can refuse, and how to tell afterwards
 * whether it did. A batch reports the failure but not which predicate broke,
 * and every predicate in it was true when the operation that queued it
 * answered its caller — so the answer is read back from committed rows.
 */
type ConflictProbe = Readonly<{
  kind: TasksStoreConflictKind
  broken: () => Promise<string | undefined>
}>

type Unit = {
  statements: D1PreparedStatement[]
  probes: ConflictProbe[]
  overlay: Overlay
}

function emptyUnit(): Unit {
  return {
    statements: [],
    probes: [],
    overlay: { presets: new Map(), tasks: new Map(), links: new Map(), receipts: new Map() },
  }
}

function overlayKey(...parts: (string | number)[]): string {
  return parts.join(" ")
}

function hasWritten(unit: Unit | undefined): boolean {
  if (!unit) return false
  const { presets, tasks, links, receipts } = unit.overlay
  return presets.size + tasks.size + links.size + receipts.size > 0
}

/**
 * A list or count read after the unit's first write would answer from
 * committed rows alone and silently miss the unit's own. Every list guard in
 * the kit runs before its unit writes anything, so this is unreachable — and a
 * future one that is not is a wrong answer, which is worth more as a crash
 * than as a page.
 */
function refuseListAfterWrite(unit: Unit | undefined, what: string): void {
  if (hasWritten(unit)) {
    throw new Error(`Tasks ${what} cannot be read inside a unit that has already written rows`)
  }
}

/** One list read as a SQL clause: the cursor seek, and how many rows to ask for. */
function windowClause(query: ListQuery, idColumn: string): { limit: number; where: string; bindings: unknown[] } {
  const bounds = tasksPageBounds(query)
  if (!bounds.cursor) return { limit: bounds.limit, where: "", bindings: [] }
  return {
    limit: bounds.limit,
    where: ` and (created_at < ? or (created_at = ? and ${idColumn} < ?))`,
    bindings: [bounds.cursor.createdAt, bounds.cursor.createdAt, bounds.cursor.id],
  }
}

export function createD1TasksStore(input: D1TasksStoreInput): TasksStorePort {
  const database = input.database

  const committedRevision = async (table: string, idColumn: string, scopeId: string, id: string) => {
    const row = await database
      .prepare(`select revision from ${table} where scope_id = ? and ${idColumn} = ?`)
      .bind(scopeId, id)
      .first<{ revision: number }>()
    return row?.revision
  }

  /**
   * The revision predicate as both halves it needs: the statement that refuses
   * the batch when the row has left `expectedRevision`, and the read that says
   * so afterwards. One description serves both, so the refusal the caller sees
   * cannot drift from the one the batch enforced.
   */
  const revisionGuard = (
    what: string,
    table: string,
    idColumn: string,
    scopeId: string,
    id: string,
    expectedRevision: number,
  ) => {
    const refusal = `${what} left revision ${expectedRevision}`
    return {
      statement: database
        .prepare(
          `insert into task_write_guards (refusal) select ? where not exists (` +
            `select 1 from ${table} where scope_id = ? and ${idColumn} = ? and revision = ?)`,
        )
        .bind(refusal, scopeId, id, expectedRevision),
      probe: {
        kind: "stale-revision",
        broken: async () => ((await committedRevision(table, idColumn, scopeId, id)) === expectedRevision ? undefined : refusal),
      } satisfies ConflictProbe,
    }
  }

  const classify = async (probes: readonly ConflictProbe[], cause: unknown): Promise<TasksStoreConflict | undefined> => {
    const ordered = [...probes].sort(
      (left, right) => TASKS_STORE_CONFLICTS.indexOf(left.kind) - TASKS_STORE_CONFLICTS.indexOf(right.kind),
    )
    for (const probe of ordered) {
      const broken = await probe.broken()
      if (broken) return new TasksStoreConflict(probe.kind, broken, { cause })
    }
    return undefined
  }

  const runBatch = async (statements: readonly D1PreparedStatement[], probes: readonly ConflictProbe[]): Promise<void> => {
    try {
      await database.batch([...statements])
    } catch (cause) {
      throw (await classify(probes, cause)) ?? cause
    }
  }

  /** Outside a unit a write is its own commit; inside one it joins the batch. */
  const commit = async (
    unit: Unit | undefined,
    statements: readonly D1PreparedStatement[],
    record: (overlay: Overlay) => void,
    probes: readonly ConflictProbe[] = [],
  ): Promise<void> => {
    if (!unit) {
      await runBatch(statements, probes)
      return
    }
    unit.statements.push(...statements)
    unit.probes.push(...probes)
    record(unit.overlay)
  }

  const storedLink = async (
    scopeId: string,
    taskId: string,
    slot: ConfigurationSlot,
    attempt: number,
  ): Promise<TaskSessionLink | undefined> => {
    const row = await database
      .prepare(
        `select ${LINK_COLUMNS} from task_session_links where scope_id = ? and task_id = ? and slot = ? and attempt = ?`,
      )
      .bind(scopeId, taskId, slot, attempt)
      .first<StoredLinkColumns>()
    return row ? linkOfColumns(row) : undefined
  }

  const operations = (unit?: Unit): TasksStoreOperations => ({
    presets: {
      async get(scopeId, presetId) {
        const pending = unit?.overlay.presets.get(overlayKey(scopeId, presetId))
        if (pending) return pending
        const row = await database
          .prepare(`select ${PRESET_COLUMNS} from task_presets where scope_id = ? and preset_id = ?`)
          .bind(scopeId, presetId)
          .first<StoredPresetColumns>()
        return row ? presetOfColumns(row) : undefined
      },

      async list(scopeId, ownerId, query) {
        refuseListAfterWrite(unit, "presets")
        const page = windowClause(query, "preset_id")
        const archived = query.includeArchived ? "" : " and archived_at is null"
        const rows = await database
          .prepare(
            `select ${PRESET_COLUMNS} from task_presets where scope_id = ? and owner_id = ?${archived}${page.where}` +
              ` order by created_at desc, preset_id desc limit ?`,
          )
          .bind(scopeId, ownerId, ...page.bindings, page.limit + 1)
          .all<StoredPresetColumns>()
        return tasksPage(rows.results, page.limit, presetOfColumns)
      },

      async insert(preset) {
        const values = presetValues(preset)
        await commit(
          unit,
          [database.prepare(insertStatement("task_presets", PRESET_COLUMNS, values)).bind(...values)],
          (overlay) => overlay.presets.set(overlayKey(preset.scopeId, preset.id), preset),
        )
      },

      async update(preset, expectedRevision) {
        const set = assignment(PRESET_COLUMNS, ["scope_id", "preset_id"], presetValues(preset))
        const statement = database
          .prepare(`update task_presets set ${set.clause} where scope_id = ? and preset_id = ? and revision = ?`)
          .bind(...set.values, preset.scopeId, preset.id, expectedRevision)
        if (!unit) {
          const result = await statement.run()
          return (result.meta.changes ?? 0) > 0
        }
        const key = overlayKey(preset.scopeId, preset.id)
        const pending = unit.overlay.presets.get(key)
        const stored = pending ?? (await this.get(preset.scopeId, preset.id))
        if (!stored || stored.revision !== expectedRevision) return false
        // A row this unit wrote needs no guard: the statement that wrote it is
        // in the same batch, so nothing outside can have moved it.
        const guard = pending
          ? undefined
          : revisionGuard(`preset ${preset.id}`, "task_presets", "preset_id", preset.scopeId, preset.id, expectedRevision)
        await commit(
          unit,
          guard ? [guard.statement, statement] : [statement],
          (overlay) => overlay.presets.set(key, preset),
          guard ? [guard.probe] : [],
        )
        return true
      },

      async assertRevision(scopeId, presetId, revision) {
        const pending = unit?.overlay.presets.get(overlayKey(scopeId, presetId))
        if (pending) return pending.revision === revision
        if ((await committedRevision("task_presets", "preset_id", scopeId, presetId)) !== revision) return false
        // Outside a unit the read above is the whole answer. Inside one it is
        // only the read this unit started from, so the predicate joins the
        // batch: a row that moves before the batch runs refuses it there.
        if (!unit) return true
        const guard = revisionGuard(`preset ${presetId}`, "task_presets", "preset_id", scopeId, presetId, revision)
        await commit(unit, [guard.statement], () => {}, [guard.probe])
        return true
      },
    },

    tasks: {
      async get(scopeId, taskId) {
        const pending = unit?.overlay.tasks.get(overlayKey(scopeId, taskId))
        if (pending) return pending
        const row = await database
          .prepare(`select ${TASK_COLUMNS} from tasks where scope_id = ? and task_id = ?`)
          .bind(scopeId, taskId)
          .first<StoredTaskColumns>()
        return row ? taskOfColumns(row) : undefined
      },

      async list(scopeId, query) {
        refuseListAfterWrite(unit, "tasks")
        const page = windowClause(query, "task_id")
        const filters: string[] = []
        const bindings: unknown[] = [scopeId, query.projectId]
        if (!query.includeArchived) filters.push(" and archived_at is null")
        if (query.status !== null) {
          filters.push(" and status = ?")
          bindings.push(query.status)
        }
        if (query.parent === "root") filters.push(" and parent_task_id is null")
        const rows = await database
          .prepare(
            `select ${TASK_COLUMNS} from tasks where scope_id = ? and project_id = ?${filters.join("")}${page.where}` +
              ` order by created_at desc, task_id desc limit ?`,
          )
          .bind(...bindings, ...page.bindings, page.limit + 1)
          .all<StoredTaskColumns>()
        const links = await preparedLinkCounts(database, scopeId, tasksPageRows(rows.results, page.limit).map((row) => row.task_id))
        return tasksPage(rows.results, page.limit, (row) => taskSummaryOf(taskOfColumns(row), links(row.task_id)))
      },

      async listChildren(scopeId, parentTaskId, query) {
        refuseListAfterWrite(unit, "children")
        const page = windowClause(query, "task_id")
        const archived = query.includeArchived ? "" : " and archived_at is null"
        const rows = await database
          .prepare(
            `select ${TASK_COLUMNS} from tasks where scope_id = ? and parent_task_id = ?${archived}${page.where}` +
              ` order by created_at desc, task_id desc limit ?`,
          )
          .bind(scopeId, parentTaskId, ...page.bindings, page.limit + 1)
          .all<StoredTaskColumns>()
        const links = await preparedLinkCounts(database, scopeId, tasksPageRows(rows.results, page.limit).map((row) => row.task_id))
        return tasksPage(rows.results, page.limit, (row) => taskSummaryOf(taskOfColumns(row), links(row.task_id)))
      },

      async countChildren(scopeId, parentTaskId, filter) {
        refuseListAfterWrite(unit, "children")
        const bindings: unknown[] = [scopeId, parentTaskId]
        let clauses = filter.includeArchived ? "" : " and archived_at is null"
        if (filter.excludeStatus !== null) {
          clauses += " and status <> ?"
          bindings.push(filter.excludeStatus)
        }
        const row = await database
          .prepare(`select count(*) as children from tasks where scope_id = ? and parent_task_id = ?${clauses}`)
          .bind(...bindings)
          .first<{ children: number }>()
        return row?.children ?? 0
      },

      async insert(task) {
        const values = taskValues(task)
        await commit(
          unit,
          [database.prepare(insertStatement("tasks", TASK_COLUMNS, values)).bind(...values)],
          (overlay) => overlay.tasks.set(overlayKey(task.scopeId, task.id), task),
        )
      },

      async update(task, expectedRevision) {
        const set = assignment(TASK_COLUMNS, ["scope_id", "task_id"], taskValues(task))
        const statement = database
          .prepare(`update tasks set ${set.clause} where scope_id = ? and task_id = ? and revision = ?`)
          .bind(...set.values, task.scopeId, task.id, expectedRevision)
        if (!unit) {
          const result = await statement.run()
          return (result.meta.changes ?? 0) > 0
        }
        const key = overlayKey(task.scopeId, task.id)
        const pending = unit.overlay.tasks.get(key)
        const stored = pending ?? (await this.get(task.scopeId, task.id))
        if (!stored || stored.revision !== expectedRevision) return false
        const guard = pending
          ? undefined
          : revisionGuard(`task ${task.id}`, "tasks", "task_id", task.scopeId, task.id, expectedRevision)
        await commit(
          unit,
          guard ? [guard.statement, statement] : [statement],
          (overlay) => overlay.tasks.set(key, task),
          guard ? [guard.probe] : [],
        )
        return true
      },
    },

    links: {
      async getCurrent(scopeId, taskId, slot) {
        const row = await database
          .prepare(
            `select ${LINK_COLUMNS} from task_session_links where scope_id = ? and task_id = ? and slot = ?` +
              ` order by attempt desc limit 1`,
          )
          .bind(scopeId, taskId, slot)
          .first<StoredLinkColumns>()
        const pending = [...(unit?.overlay.links.values() ?? [])].filter(
          (link) => link.scopeId === scopeId && link.taskId === taskId && link.slot === slot,
        )
        return [...pending, ...(row ? [linkOfColumns(row)] : [])].sort((left, right) => right.attempt - left.attempt)[0]
      },

      async listByTask(scopeId, taskId) {
        refuseListAfterWrite(unit, "session links")
        const rows = await database
          .prepare(
            `select ${LINK_COLUMNS} from task_session_links where scope_id = ? and task_id = ?` +
              ` order by slot asc, attempt desc`,
          )
          .bind(scopeId, taskId)
          .all<StoredLinkColumns>()
        return rows.results.map(linkOfColumns)
      },

      async insert(link) {
        const key = overlayKey(link.scopeId, link.taskId, link.slot, link.attempt)
        const held = unit?.overlay.links.get(key) ?? (await storedLink(link.scopeId, link.taskId, link.slot, link.attempt))
        if (held) return { status: "exists", link: held }
        const values = linkValues(link)
        // A plain insert, not `on conflict do nothing`: a client that claims
        // this origin first must make this write fail rather than let two
        // sessions report themselves as the slot's attempt.
        await commit(
          unit,
          [database.prepare(insertStatement("task_session_links", LINK_COLUMNS, values)).bind(...values)],
          (overlay) => overlay.links.set(key, link),
          [
            {
              kind: "link-conflict",
              broken: async () =>
                (await storedLink(link.scopeId, link.taskId, link.slot, link.attempt))
                  ? `session link ${link.taskId}/${link.slot}/${link.attempt} was claimed by another session`
                  : undefined,
            },
          ],
        )
        return { status: "inserted" }
      },
    },

    receipts: {
      async get(scopeId, clientRequestId) {
        const pending = unit?.overlay.receipts.get(overlayKey(scopeId, clientRequestId))
        if (pending) return pending
        const row = await database
          .prepare(`select ${RECEIPT_COLUMNS} from task_command_receipts where scope_id = ? and client_request_id = ?`)
          .bind(scopeId, clientRequestId)
          .first<StoredReceiptColumns>()
        return row ? receiptOfColumns(row) : undefined
      },

      async put(receipt) {
        if (await this.get(receipt.scopeId, receipt.clientRequestId)) return false
        const values = receiptValues(receipt)
        const statement = database
          .prepare(insertStatement("task_command_receipts", RECEIPT_COLUMNS, values))
          .bind(...values)
        // The primary key is the whole race, here and in the batch: a second
        // client holding the same request id fails this insert rather than
        // replacing the result the first one committed.
        if (!unit) {
          return await statement
            .run()
            .then(() => true)
            .catch(() => false)
        }
        await commit(
          unit,
          [statement],
          (overlay) => overlay.receipts.set(overlayKey(receipt.scopeId, receipt.clientRequestId), receipt),
          [
            {
              kind: "duplicate-receipt",
              broken: async () =>
                (await database
                  .prepare(`select client_request_id from task_command_receipts where scope_id = ? and client_request_id = ?`)
                  .bind(receipt.scopeId, receipt.clientRequestId)
                  .first())
                  ? `client request ${receipt.clientRequestId} was committed by another request`
                  : undefined,
            },
          ],
        )
        return true
      },
    },
  })

  return {
    ...operations(),
    async transaction(work) {
      const unit = emptyUnit()
      const result = await work(operations(unit))
      if (unit.statements.length > 0) await runBatch(unit.statements, unit.probes)
      return result
    },
  }
}
