import {
  attachmentView,
  taskSummaryOf,
  type ConfigurationSlot,
  type Preset,
  type Task,
  type TaskAttachmentRecord,
  type TaskSessionLink,
} from "../contracts"
import { paginate } from "../paging"
import { serializedTransactions, type TasksCommandReceipt, type TasksStoreOperations, type TasksStorePort } from "../ports/store"

/**
 * The reference adapter: real revision predicates, a real link compare-and-set
 * and a real rollback, so the conformance suite that every durable adapter
 * runs has something to run against here.
 */

type State = {
  presets: Map<string, Preset>
  tasks: Map<string, Task>
  attachments: Map<string, TaskAttachmentRecord>
  links: Map<string, TaskSessionLink>
  receipts: Map<string, TasksCommandReceipt>
}

function emptyState(): State {
  return { presets: new Map(), tasks: new Map(), attachments: new Map(), links: new Map(), receipts: new Map() }
}

function captureState(state: State): State {
  return {
    presets: new Map(state.presets),
    tasks: new Map(state.tasks),
    attachments: new Map(state.attachments),
    links: new Map(state.links),
    receipts: new Map(state.receipts),
  }
}

function restore(target: State, from: State): void {
  target.presets = from.presets
  target.tasks = from.tasks
  target.attachments = from.attachments
  target.links = from.links
  target.receipts = from.receipts
}

function rowKey(...parts: (string | number)[]): string {
  return parts.join("\0")
}

// Every crossing of the port boundary is a copy: a caller that mutates a row
// it read must not be able to rewrite stored state without an update.
function copy<T>(value: T): T {
  return structuredClone(value)
}

function operations(state: State): TasksStoreOperations {
  const presetsOf = (scopeId: string, ownerId: string) =>
    [...state.presets.values()].filter((preset) => preset.scopeId === scopeId && preset.ownerId === ownerId)

  const tasksOf = (scopeId: string) => [...state.tasks.values()].filter((task) => task.scopeId === scopeId)

  const childrenOf = (scopeId: string, parentTaskId: string) =>
    tasksOf(scopeId).filter((task) => task.parentTaskId === parentTaskId)

  const attachmentsOf = (scopeId: string, taskId: string) =>
    [...state.attachments.values()]
      .filter((attachment) => attachment.scopeId === scopeId && attachment.taskId === taskId)
      .sort((left, right) => left.position - right.position)

  // One pass over the links for the whole page, keyed by scope as well as
  // task: two scopes may hold the same task id, and a count that ignored the
  // scope would add the other tenant's sessions to this one's row.
  const linkCounts = (scopeId: string, taskIds: readonly string[]) => {
    const wanted = new Set(taskIds)
    const counts = new Map<string, number>()
    for (const link of state.links.values()) {
      if (link.scopeId !== scopeId || !wanted.has(link.taskId)) continue
      counts.set(link.taskId, (counts.get(link.taskId) ?? 0) + 1)
    }
    return (taskId: string) => ({ count: counts.get(taskId) ?? 0 })
  }

  // One pass over the scope's tasks for the whole page. Archived children are
  // skipped on both numbers, so a parent whose only child was archived reads
  // as having none rather than as having one it can never finish.
  const childCounts = (scopeId: string, taskIds: readonly string[]) => {
    const wanted = new Set(taskIds)
    const counts = new Map<string, { total: number; done: number }>()
    for (const task of tasksOf(scopeId)) {
      const parent = task.parentTaskId
      if (parent === null || !wanted.has(parent) || task.archivedAt !== null) continue
      const current = counts.get(parent) ?? { total: 0, done: 0 }
      counts.set(parent, { total: current.total + 1, done: current.done + (task.status === "done" ? 1 : 0) })
    }
    return (taskId: string) => counts.get(taskId) ?? { total: 0, done: 0 }
  }

  return {
    presets: {
      async get(scopeId, presetId) {
        const preset = state.presets.get(rowKey(scopeId, presetId))
        return preset ? copy(preset) : undefined
      },
      async list(scopeId, ownerId, query) {
        const rows = presetsOf(scopeId, ownerId).filter((preset) => query.includeArchived || preset.archivedAt === null)
        const page = paginate(rows, query)
        return { items: page.items.map((preset) => copy(preset)), nextCursor: page.nextCursor }
      },
      async insert(preset) {
        const id = rowKey(preset.scopeId, preset.id)
        if (state.presets.has(id)) throw new Error(`Preset ${preset.id} already exists`)
        state.presets.set(id, copy(preset))
      },
      async update(preset, expectedRevision) {
        const id = rowKey(preset.scopeId, preset.id)
        const stored = state.presets.get(id)
        if (!stored || stored.revision !== expectedRevision) return false
        state.presets.set(id, copy(preset))
        return true
      },
      async assertRevision(scopeId, presetId, revision) {
        return state.presets.get(rowKey(scopeId, presetId))?.revision === revision
      },
    },

    tasks: {
      async get(scopeId, taskId) {
        const task = state.tasks.get(rowKey(scopeId, taskId))
        return task ? copy(task) : undefined
      },
      async list(scopeId, query) {
        const rows = tasksOf(scopeId).filter(
          (task) =>
            task.projectId === query.projectId &&
            (query.includeArchived || task.archivedAt === null) &&
            (query.status === null || task.status === query.status) &&
            (query.parent === "any" || task.parentTaskId === null),
        )
        const page = paginate(rows, query)
        const ids = page.items.map((task) => task.id)
        const links = linkCounts(scopeId, ids)
        const children = childCounts(scopeId, ids)
        return {
          items: page.items.map((task) => taskSummaryOf(copy(task), links(task.id), children(task.id))),
          nextCursor: page.nextCursor,
        }
      },
      async listChildren(scopeId, parentTaskId, query) {
        const rows = childrenOf(scopeId, parentTaskId).filter((task) => query.includeArchived || task.archivedAt === null)
        const page = paginate(rows, query)
        const ids = page.items.map((task) => task.id)
        const links = linkCounts(scopeId, ids)
        const children = childCounts(scopeId, ids)
        return {
          items: page.items.map((task) => taskSummaryOf(copy(task), links(task.id), children(task.id))),
          nextCursor: page.nextCursor,
        }
      },
      async countChildren(scopeId, parentTaskId, filter) {
        return childrenOf(scopeId, parentTaskId).filter(
          (task) =>
            (filter.includeArchived || task.archivedAt === null) &&
            (filter.excludeStatus === null || task.status !== filter.excludeStatus),
        ).length
      },
      async nextNumber(scopeId, projectId) {
        return (
          tasksOf(scopeId)
            .filter((task) => task.projectId === projectId)
            .reduce((highest, task) => Math.max(highest, task.number), 0) + 1
        )
      },
      async insert(task) {
        const id = rowKey(task.scopeId, task.id)
        if (state.tasks.has(id)) throw new Error(`Task ${task.id} already exists`)
        state.tasks.set(id, copy(task))
      },
      async update(task, expectedRevision) {
        const id = rowKey(task.scopeId, task.id)
        const stored = state.tasks.get(id)
        if (!stored || stored.revision !== expectedRevision) return false
        state.tasks.set(id, copy(task))
        return true
      },
    },

    attachments: {
      async list(scopeId, taskId) {
        return attachmentsOf(scopeId, taskId).map((attachment) => attachmentView(attachment))
      },
      async get(scopeId, taskId, attachmentId) {
        const attachment = state.attachments.get(rowKey(scopeId, taskId, attachmentId))
        return attachment ? copy(attachment) : undefined
      },
      async listWithBytes(scopeId, taskId) {
        return attachmentsOf(scopeId, taskId).map((attachment) => copy(attachment))
      },
      async insert(attachment) {
        const id = rowKey(attachment.scopeId, attachment.taskId, attachment.id)
        if (state.attachments.has(id)) throw new Error(`Attachment ${attachment.id} already exists`)
        state.attachments.set(id, copy(attachment))
      },
    },

    links: {
      async getCurrent(scopeId, taskId, slot: ConfigurationSlot) {
        const attempts = [...state.links.values()]
          .filter((link) => link.scopeId === scopeId && link.taskId === taskId && link.slot === slot)
          .sort((left, right) => right.attempt - left.attempt)
        const current = attempts[0]
        return current ? copy(current) : undefined
      },
      async listByTask(scopeId, taskId) {
        return [...state.links.values()]
          .filter((link) => link.scopeId === scopeId && link.taskId === taskId)
          .sort((left, right) => (left.slot === right.slot ? right.attempt - left.attempt : left.slot < right.slot ? -1 : 1))
          .map((link) => copy(link))
      },
      async bySession(scopeId, sessionId) {
        const link = [...state.links.values()].find(
          (candidate) => candidate.scopeId === scopeId && candidate.sessionRef.sessionId === sessionId,
        )
        return link ? copy(link) : undefined
      },
      async listAgentStartedCloud(scopeId, projectId) {
        const inProject = new Set(
          tasksOf(scopeId)
            .filter((task) => task.projectId === projectId)
            .map((task) => task.id),
        )
        return [...state.links.values()]
          .filter(
            (link) =>
              link.scopeId === scopeId
              && inProject.has(link.taskId)
              && link.startedBy === "agent"
              && link.placement === "cloud",
          )
          .sort((left, right) => right.createdAt - left.createdAt)
          .map((link) => copy(link))
      },
      async insert(link) {
        const id = rowKey(link.scopeId, link.taskId, link.slot, link.attempt)
        const stored = state.links.get(id)
        if (stored) return { status: "exists", link: copy(stored) }
        state.links.set(id, copy(link))
        return { status: "inserted" }
      },
    },

    receipts: {
      async get(scopeId, clientRequestId) {
        const receipt = state.receipts.get(rowKey(scopeId, clientRequestId))
        return receipt ? copy(receipt) : undefined
      },
      async put(receipt) {
        const id = rowKey(receipt.scopeId, receipt.clientRequestId)
        if (state.receipts.has(id)) return false
        state.receipts.set(id, copy(receipt))
        return true
      },
    },
  }
}

export function createMemoryTasksStore(): TasksStorePort {
  const state = emptyState()
  // Rollback is a snapshot of the whole store, which is only a rollback while
  // no second unit is open: restoring what the store held when this unit began
  // would also delete the writes of a unit that committed in between.
  return {
    ...operations(state),
    transaction: serializedTransactions(async (work) => {
      const before = captureState(state)
      try {
        return await work(operations(state))
      } catch (cause) {
        restore(state, before)
        throw cause
      }
    }),
  }
}
