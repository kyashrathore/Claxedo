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
import { CONFORMANCE_SCOPES, TASKS_STORE_CONFORMANCE_SCOPE, TASKS_STORE_CONFORMANCE_VERSION, tasksStoreConformance } from "./index"
import { createMemoryTasksStore } from "../stores/memory"
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
      insert: (task) => record((into) => into.tasks.insert(task), live.tasks.insert(task)),
      update: (task, revision) => record((into) => into.tasks.update(task, revision), live.tasks.update(task, revision)),
    },
    links: {
      getCurrent: (scopeId, taskId, slot) => live.links.getCurrent(scopeId, taskId, slot),
      listByTask: (scopeId, taskId) => live.links.listByTask(scopeId, taskId),
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
]

describe("tasks store conformance", () => {
  const cases = tasksStoreConformance(async () => ({ store: createMemoryTasksStore() }))

  test("the pinned manifest lists exactly the cases the suite runs", () => {
    expect(TASKS_STORE_CONFORMANCE_VERSION).toBe(3)
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
