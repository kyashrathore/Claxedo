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
  type ConfigurationSlot,
  type ListQuery,
  type Preset,
  type Task,
  type TaskSessionLink,
  type TasksCommandReceipt,
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
  childCountLookup,
  linkCountLookup,
  taskSummaryPage,
  tasksPage,
  tasksPageBounds,
} from "@claxedo/server-core/tasks-host/paging"
import {
  taskNumberTakenRefusal,
  tasksStoreConflict,
  type TasksConflictProbe,
} from "@claxedo/server-core/tasks-host/store-conflicts"

export type D1TasksStoreInput = Readonly<{ database: D1Database }>

const PRESET_COLUMNS =
  "scope_id, preset_id, revision, owner_id, name, instructions, execution, configurations, agent_startable, archived_at, created_at, updated_at"
const TASK_COLUMNS =
  "scope_id, task_id, revision, project_id, number, workspace_id, parent_task_id, created_from_session_id, created_from_workspace_id, title, description, status, child_set_revision, archived_at, created_at, updated_at"
const LINK_COLUMNS =
  "scope_id, task_id, slot, attempt, session_id, session_workspace_id, continued_from_session_id, continued_from_workspace_id, preset_id, preset_revision, preset_name_at_start, configuration_digest, handoff_text, started_from_session_id, started_from_workspace_id, started_by, placement, created_at"
/** `LINK_COLUMNS` qualified for a read that joins the task table. */
const JOINED_LINK_COLUMNS = LINK_COLUMNS.split(", ")
  .map((column) => `l.${column}`)
  .join(", ")
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
    row.agent_startable,
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
    row.number,
    row.workspace_id,
    row.parent_task_id,
    row.created_from_session_id,
    row.created_from_workspace_id,
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
 * One prepared statement over the whole page's children. Archived rows are
 * excluded from both numbers, so a parent whose only child was archived reads
 * as having none rather than as owing one it can never finish.
 */
async function preparedChildCounts(database: D1Database, scopeId: string, taskIds: readonly string[]) {
  if (taskIds.length === 0) return childCountLookup([])
  const placeholders = taskIds.map(() => "?").join(", ")
  const rows = await database
    .prepare(
      `select parent_task_id, count(*) as total, sum(case when status = 'done' then 1 else 0 end) as done` +
        ` from tasks where scope_id = ? and parent_task_id in (${placeholders}) and archived_at is null` +
        ` group by parent_task_id`,
    )
    .bind(scopeId, ...taskIds)
    .all<{ parent_task_id: string; total: number; done: number }>()
  return childCountLookup(
    rows.results.map((row) => ({ taskId: row.parent_task_id, total: row.total, done: row.done ?? 0 })),
  )
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
    row.started_from_session_id,
    row.started_from_workspace_id,
    row.started_by,
    row.placement,
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

type Unit = {
  statements: D1PreparedStatement[]
  probes: TasksConflictProbe[]
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
      } satisfies TasksConflictProbe,
    }
  }

  const runBatch = async (
    statements: readonly D1PreparedStatement[],
    probes: readonly TasksConflictProbe[],
  ): Promise<void> => {
    try {
      await database.batch([...statements])
    } catch (cause) {
      throw (await tasksStoreConflict(probes, cause)) ?? cause
    }
  }

  /** Outside a unit a write is its own commit; inside one it joins the batch. */
  const commit = async (
    unit: Unit | undefined,
    statements: readonly D1PreparedStatement[],
    record: (overlay: Overlay) => void,
    probes: readonly TasksConflictProbe[] = [],
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

  const receiptHolder = async (receipt: TasksCommandReceipt): Promise<boolean> =>
    (await database
      .prepare(`select client_request_id from task_command_receipts where scope_id = ? and client_request_id = ?`)
      .bind(receipt.scopeId, receipt.clientRequestId)
      .first()) !== null

  /** The task, other than this one, that holds this project's number — the whole of what the unique index refuses. */
  const numberHolder = async (task: Task): Promise<string | undefined> => {
    const row = await database
      .prepare(`select task_id from tasks where scope_id = ? and project_id = ? and number = ? and task_id <> ?`)
      .bind(task.scopeId, task.projectId, task.number, task.id)
      .first<{ task_id: string }>()
    return row?.task_id
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
        return taskSummaryPage(rows.results, page.limit, async (taskIds) => ({
          links: await preparedLinkCounts(database, scopeId, taskIds),
          children: await preparedChildCounts(database, scopeId, taskIds),
        }))
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
        return taskSummaryPage(rows.results, page.limit, async (taskIds) => ({
          links: await preparedLinkCounts(database, scopeId, taskIds),
          children: await preparedChildCounts(database, scopeId, taskIds),
        }))
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

      async nextNumber(scopeId, projectId) {
        refuseListAfterWrite(unit, "task numbers")
        const row = await database
          .prepare(`select max(number) as highest from tasks where scope_id = ? and project_id = ?`)
          .bind(scopeId, projectId)
          .first<{ highest: number | null }>()
        return (row?.highest ?? 0) + 1
      },

      async insert(task) {
        const values = taskValues(task)
        // The number was read from committed rows, so a create that raced this
        // one takes it in the unique index rather than here; the probe is what
        // turns that batch refusal back into the collision it was.
        await commit(
          unit,
          [database.prepare(insertStatement("tasks", TASK_COLUMNS, values)).bind(...values)],
          (overlay) => overlay.tasks.set(overlayKey(task.scopeId, task.id), task),
          [
            {
              kind: "number-taken",
              broken: async () =>
                (await numberHolder(task)) ? taskNumberTakenRefusal(task.projectId, task.number) : undefined,
            },
          ],
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

      async bySession(scopeId, sessionId) {
        const pending = [...(unit?.overlay.links.values() ?? [])].find(
          (link) => link.scopeId === scopeId && link.sessionRef.sessionId === sessionId,
        )
        if (pending) return pending
        const row = await database
          .prepare(`select ${LINK_COLUMNS} from task_session_links where scope_id = ? and session_id = ?`)
          .bind(scopeId, sessionId)
          .first<StoredLinkColumns>()
        return row ? linkOfColumns(row) : undefined
      },

      async listAgentStartedCloud(scopeId, projectId) {
        refuseListAfterWrite(unit, "agent-started links")
        const rows = await database
          .prepare(
            `select ${JOINED_LINK_COLUMNS} from task_session_links l` +
              ` join tasks t on t.scope_id = l.scope_id and t.task_id = l.task_id` +
              ` where l.scope_id = ? and t.project_id = ? and l.started_by = 'agent' and l.placement = 'cloud'` +
              ` order by l.created_at desc`,
          )
          .bind(scopeId, projectId)
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
        const duplicate: TasksConflictProbe = {
          kind: "duplicate-receipt",
          broken: async () =>
            (await receiptHolder(receipt))
              ? `client request ${receipt.clientRequestId} was committed by another request`
              : undefined,
        }
        if (!unit) {
          try {
            await statement.run()
          } catch (cause) {
            // `false` is the one answer that makes the command layer replay a
            // committed result, so only a row that is actually there may
            // produce it; a transport failure has to keep travelling.
            if (!(await duplicate.broken())) throw cause
            return false
          }
          return true
        }
        await commit(
          unit,
          [statement],
          (overlay) => overlay.receipts.set(overlayKey(receipt.scopeId, receipt.clientRequestId), receipt),
          [duplicate],
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
