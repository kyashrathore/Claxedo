/**
 * Proof that the store conformance suite detects the divergences it claims.
 *
 * The suite is the only thing that will keep a SQLite adapter and a D1 adapter
 * agreeing about rollback, arbitration, origin uniqueness and scope isolation,
 * and a suite
 * whose assertion was weakened looks exactly like a suite that is passing
 * honestly. So every pinned case is paired with a store that breaks what the
 * case names, and the case must refuse against it.
 *
 * The pairing is positional: mutant `i` is checked against case `i`, and the
 * counts must match, so a case added without a mutant fails this file instead
 * of joining the suite unproven. Mutants overlap — several of them break more
 * than one case — and that is fine: what is asserted is that each case catches
 * its own.
 */
import { describe, expect, test } from "bun:test"
import { CONFORMANCE_SCOPES, TASKS_STORE_CONFORMANCE_SCOPE, tasksStoreConformance } from "./index"
import { createMemoryTasksStore } from "../stores/memory"
import type { Page, Preset, Task, TaskSessionLink, TaskSummary } from "../contracts"
import type { TasksStoreOperations, TasksStorePort } from "../ports/store"

type Mutant = Readonly<{
  breaks: string
  apply: (store: TasksStorePort) => TasksStorePort
}>

/**
 * A store wrong in one way everywhere, including inside its own transactions —
 * a wrapper that only replaces the top-level operations leaves the real ones
 * in every unit of work and proves nothing about the cases that open one.
 */
function everywhere(apply: (operations: TasksStoreOperations) => TasksStoreOperations) {
  return (store: TasksStorePort): TasksStorePort => ({
    ...apply(store),
    transaction: (work) => store.transaction((operations) => work(apply(operations))),
  })
}

/**
 * The revision the caller passed, replaced by the one the store reads for
 * itself at write time — so every compare-and-set succeeds, including the one
 * whose evidence a concurrent writer has already invalidated.
 */
const REREADS_THE_REVISION = everywhere((operations) => ({
  ...operations,
  tasks: {
    ...operations.tasks,
    update: async (task) => {
      await operations.tasks.update(task, (await operations.tasks.get(task.scopeId, task.id))?.revision ?? 0)
      return true
    },
  },
}))

/**
 * Every write recorded, and a failed unit "rolled back" by replaying the
 * recording as it stood when that unit opened — the memory store's rollback
 * before it queued its units. Nothing arbitrates two open units, so the replay
 * also erases whatever committed between them.
 */
function snapshotRollback(): TasksStorePort {
  type Write = (operations: TasksStoreOperations) => Promise<unknown>
  let live = createMemoryTasksStore()
  const log: Write[] = []
  const record = <Result>(replay: Write, applied: Promise<Result>): Promise<Result> => {
    log.push(replay)
    return applied
  }
  const operations: TasksStoreOperations = {
    presets: {
      get: (scopeId, presetId) => live.presets.get(scopeId, presetId),
      list: (scopeId, ownerId, query) => live.presets.list(scopeId, ownerId, query),
      insert: (preset) => record((into) => into.presets.insert(preset), live.presets.insert(preset)),
      update: (preset, revision) => record((into) => into.presets.update(preset, revision), live.presets.update(preset, revision)),
      assertRevision: (scopeId, presetId, revision) => live.presets.assertRevision(scopeId, presetId, revision),
    },
    tasks: {
      get: (scopeId, taskId) => live.tasks.get(scopeId, taskId),
      list: (scopeId, query) => live.tasks.list(scopeId, query),
      listChildren: (scopeId, parentTaskId, query) => live.tasks.listChildren(scopeId, parentTaskId, query),
      countChildren: (scopeId, parentTaskId, filter) => live.tasks.countChildren(scopeId, parentTaskId, filter),
      nextNumber: (scopeId, projectId) => live.tasks.nextNumber(scopeId, projectId),
      insert: (task) => record((into) => into.tasks.insert(task), live.tasks.insert(task)),
      update: (task, revision) => record((into) => into.tasks.update(task, revision), live.tasks.update(task, revision)),
    },
    links: {
      getCurrent: (scopeId, taskId, slot) => live.links.getCurrent(scopeId, taskId, slot),
      listByTask: (scopeId, taskId) => live.links.listByTask(scopeId, taskId),
      bySession: (scopeId, sessionId) => live.links.bySession(scopeId, sessionId),
      listAgentStartedCloud: (scopeId, projectId) => live.links.listAgentStartedCloud(scopeId, projectId),
      insert: (link) => record((into) => into.links.insert(link), live.links.insert(link)),
    },
    receipts: {
      get: (scopeId, clientRequestId) => live.receipts.get(scopeId, clientRequestId),
      put: (receipt) => record((into) => into.receipts.put(receipt), live.receipts.put(receipt)),
    },
  }
  return {
    ...operations,
    transaction: async (work) => {
      const opened = log.length
      try {
        return await work(operations)
      } catch (cause) {
        const replay = log.splice(0, log.length).slice(0, opened)
        live = createMemoryTasksStore()
        for (const write of replay) await write(live)
        log.push(...replay)
        throw cause
      }
    },
  }
}

/**
 * Link counts taken without the scope: the same answer a `task_id in (…)`
 * group returns when the query forgets that a link's key spans the scope too.
 */
const COUNTS_LINKS_ACROSS_SCOPES = everywhere((operations) => ({
  ...operations,
  tasks: {
    ...operations.tasks,
    list: async (scopeId, query) => {
      const page = await operations.tasks.list(scopeId, query)
      const other = scopeId === CONFORMANCE_SCOPES.first ? CONFORMANCE_SCOPES.second : CONFORMANCE_SCOPES.first
      const items = await Promise.all(
        page.items.map(async (row) => ({
          ...row,
          links: {
            count:
              (await operations.links.listByTask(scopeId, row.id)).length +
              (await operations.links.listByTask(other, row.id)).length,
          },
        })),
      )
      return { ...page, items }
    },
  },
}))

/**
 * Child counts taken from the page's own rows: the shape a view has whenever it
 * folds the list it was given instead of asking the store, which undercounts as
 * soon as a filter or a page boundary hides a child.
 */
const COUNTS_CHILDREN_FROM_THE_PAGE = everywhere((operations) => ({
  ...operations,
  tasks: {
    ...operations.tasks,
    list: async (scopeId, query) => {
      const page = await operations.tasks.list(scopeId, query)
      const items = page.items.map((row) => {
        const seen = page.items.filter((other) => other.parentTaskId === row.id && other.archivedAt === null)
        return { ...row, children: { total: seen.length, done: seen.filter((entry) => entry.status === "done").length } }
      })
      return { ...page, items }
    },
  },
}))

/** One sequence for the scope: the shape a `max(number)` query has when it forgets the project. */
const MINTS_NUMBERS_ACROSS_PROJECTS = everywhere((operations) => ({
  ...operations,
  tasks: {
    ...operations.tasks,
    nextNumber: async (scopeId, projectId) =>
      Math.max(
        await operations.tasks.nextNumber(scopeId, projectId),
        await operations.tasks.nextNumber(scopeId, projectId === "project-alpha" ? "project-beta" : "project-alpha"),
      ),
  },
}))

/** The highest number among the rows still showing, which hands an archived task's back out. */
const REUSES_AN_ARCHIVED_NUMBER = everywhere((operations) => ({
  ...operations,
  tasks: {
    ...operations.tasks,
    nextNumber: async (scopeId, projectId) => {
      const showing = await operations.tasks.list(scopeId, {
        projectId,
        status: null,
        parent: "any",
        includeArchived: false,
        cursor: null,
        limit: 100,
      })
      return showing.items.reduce((highest, row) => Math.max(highest, row.number), 0) + 1
    },
  },
}))

/** The column an adapter never added: every task read back as created by nobody. */
const FORGETS_THE_CREATING_SESSION = everywhere((operations) => {
  const forgetTask = (task: Task): Task => ({ ...task, createdFrom: null })
  const forgetPage = (page: Page<TaskSummary>): Page<TaskSummary> => ({
    ...page,
    items: page.items.map((row): TaskSummary => ({ ...row, createdFrom: null })),
  })
  return {
    ...operations,
    tasks: {
      ...operations.tasks,
      get: async (scopeId, taskId) => {
        const task = await operations.tasks.get(scopeId, taskId)
        return task === undefined ? undefined : forgetTask(task)
      },
      list: async (scopeId, query) => forgetPage(await operations.tasks.list(scopeId, query)),
      listChildren: async (scopeId, parentTaskId, query) =>
        forgetPage(await operations.tasks.listChildren(scopeId, parentTaskId, query)),
    },
  }
})

/** The column an adapter never added: every preset read back as one no person marked. */
const FORGETS_THE_AGENT_MARK = everywhere((operations) => {
  const forget = (preset: Preset): Preset => ({ ...preset, agentStartable: false })
  return {
    ...operations,
    presets: {
      ...operations.presets,
      get: async (scopeId, presetId) => {
        const preset = await operations.presets.get(scopeId, presetId)
        return preset === undefined ? undefined : forget(preset)
      },
      list: async (scopeId, ownerId, query) => {
        const page = await operations.presets.list(scopeId, ownerId, query)
        return { ...page, items: page.items.map(forget) }
      },
    },
  }
})

/** The two columns an adapter never added: every link read back as a person's, run locally. */
const FORGETS_WHAT_STARTED_A_LINK = everywhere((operations) => {
  const forget = (link: TaskSessionLink): TaskSessionLink => ({ ...link, startedFrom: null, placement: "local" })
  const forgetOne = async (read: Promise<TaskSessionLink | undefined>) => {
    const link = await read
    return link === undefined ? undefined : forget(link)
  }
  return {
    ...operations,
    links: {
      ...operations.links,
      getCurrent: (scopeId, taskId, slot) => forgetOne(operations.links.getCurrent(scopeId, taskId, slot)),
      bySession: (scopeId, sessionId) => forgetOne(operations.links.bySession(scopeId, sessionId)),
      listByTask: async (scopeId, taskId) => (await operations.links.listByTask(scopeId, taskId)).map(forget),
    },
  }
})

/** The join an adapter forgot: every link in the scope reported as agent-started in the cloud. */
const LISTS_EVERY_LINK_AS_AGENT_STARTED = everywhere((operations) => ({
  ...operations,
  links: {
    ...operations.links,
    listAgentStartedCloud: async (scopeId, projectId) => {
      const page = await operations.tasks.list(scopeId, {
        projectId,
        status: null,
        parent: "any",
        includeArchived: true,
        cursor: null,
        limit: 100,
      })
      const links: TaskSessionLink[] = []
      for (const row of page.items) links.push(...(await operations.links.listByTask(scopeId, row.id)))
      return links
    },
  },
}))

const MUTANTS: readonly Mutant[] = [
  {
    breaks: "commits the work of a transaction that threw",
    apply: (store) => ({ ...store, transaction: async (work) => work(store) }),
  },
  {
    breaks: "writes a row whose revision predicate missed",
    apply: REREADS_THE_REVISION,
  },
  {
    breaks: "rolls back everything except the rows inserted during the unit",
    apply: (store) => {
      const inserts: Parameters<TasksStoreOperations["tasks"]["insert"]>[0][] = []
      return {
        ...store,
        transaction: async (work) => {
          try {
            return await store.transaction(async (tx) => {
              return work({ ...tx, tasks: { ...tx.tasks, insert: async (task) => void inserts.push(task) } })
            })
          } finally {
            for (const task of inserts.splice(0)) await store.tasks.insert(task)
          }
        },
      }
    },
  },
  {
    breaks: "lets a second write take an origin that is already claimed",
    apply: everywhere((operations) => ({
      ...operations,
      links: { ...operations.links, insert: async (link) => (await operations.links.insert(link), { status: "inserted" }) },
    })),
  },
  {
    breaks: "echoes the competing session back as the one the origin holds",
    apply: everywhere((operations) => ({
      ...operations,
      links: {
        ...operations.links,
        insert: async (link) => {
          const outcome = await operations.links.insert(link)
          return outcome.status === "exists" ? { status: "exists", link } : outcome
        },
      },
    })),
  },
  {
    breaks: "reports the slot's earliest attempt as its current one",
    apply: everywhere((operations) => ({
      ...operations,
      links: {
        ...operations.links,
        getCurrent: async (scopeId, taskId, slot) =>
          (await operations.links.listByTask(scopeId, taskId))
            .filter((link) => link.slot === slot)
            .sort((left, right) => left.attempt - right.attempt)[0],
      },
    })),
  },
  {
    breaks: "lets a second receipt overwrite a committed request id",
    apply: everywhere((operations) => ({
      ...operations,
      receipts: {
        ...operations.receipts,
        put: async (receipt) => {
          await operations.receipts.put(receipt)
          return true
        },
      },
    })),
  },
  {
    breaks: "returns each page in its own order",
    apply: everywhere((operations) => ({
      ...operations,
      tasks: {
        ...operations.tasks,
        list: async (scopeId, query) => {
          const page = await operations.tasks.list(scopeId, query)
          return { ...page, items: [...page.items].reverse() }
        },
      },
    })),
  },
  {
    breaks: "reads a task without its scope",
    apply: everywhere((operations) => ({
      ...operations,
      tasks: {
        ...operations.tasks,
        get: async (scopeId, taskId) =>
          (await operations.tasks.get(scopeId, taskId)) ?? (await operations.tasks.get(CONFORMANCE_SCOPES.first, taskId)),
      },
    })),
  },
  {
    breaks: "restores a snapshot of the whole store over a unit that committed beside it",
    apply: () => snapshotRollback(),
  },
  {
    breaks: "lets two overlapping units bump one row from one revision",
    apply: REREADS_THE_REVISION,
  },
  {
    breaks: "accepts every preset revision it is asked to assert",
    apply: everywhere((operations) => ({
      ...operations,
      presets: { ...operations.presets, assertRevision: async () => true },
    })),
  },
  {
    breaks: "counts another scope's sessions into this scope's list row",
    apply: COUNTS_LINKS_ACROSS_SCOPES,
  },
  {
    breaks: "counts only the children the page returned",
    apply: COUNTS_CHILDREN_FROM_THE_PAGE,
  },
  {
    breaks: "mints one number sequence for the whole scope",
    apply: MINTS_NUMBERS_ACROSS_PROJECTS,
  },
  {
    breaks: "hands an archived task's number to the next one",
    apply: REUSES_AN_ARCHIVED_NUMBER,
  },
  {
    breaks: "reads every task back as created by nobody",
    apply: FORGETS_THE_CREATING_SESSION,
  },
  {
    breaks: "reads every preset back as one nobody marked for agents",
    apply: FORGETS_THE_AGENT_MARK,
  },
  {
    breaks: "reads every link back as a person's, run locally",
    apply: FORGETS_WHAT_STARTED_A_LINK,
  },
  {
    breaks: "lists every link of the project as agent-started in the cloud",
    apply: LISTS_EVERY_LINK_AS_AGENT_STARTED,
  },
]

describe("tasks store conformance", () => {
  const cases = tasksStoreConformance(async () => ({ store: createMemoryTasksStore() }))

  test("the pinned manifest lists exactly the cases the suite runs", () => {
    expect(cases.map((entry) => entry.name.replaceAll(/[^a-z]+/g, "_"))).toEqual([...TASKS_STORE_CONFORMANCE_SCOPE.cases])
  })

  test("every pinned case has a mutant", () => {
    expect(MUTANTS).toHaveLength(TASKS_STORE_CONFORMANCE_SCOPE.cases.length)
  })

  MUTANTS.forEach((mutant, index) => {
    test(`case ${index + 1} catches a store that ${mutant.breaks}`, async () => {
      const broken = tasksStoreConformance(async () => ({ store: mutant.apply(createMemoryTasksStore()) }))
      const target = broken[index]
      expect(target).toBeDefined()
      let refused = false
      try {
        await target?.run()
      } catch {
        refused = true
      }
      expect(refused).toBe(true)
    })
  })
})
