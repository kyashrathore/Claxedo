/**
 * Proof that the store conformance suite detects the divergences it claims.
 *
 * The suite is the only thing that will keep a SQLite adapter and a D1 adapter
 * agreeing about rollback, origin uniqueness and scope isolation, and a suite
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

const MUTANTS: readonly Mutant[] = [
  {
    breaks: "commits the work of a transaction that threw",
    apply: (store) => ({ ...store, transaction: async (work) => work(store) }),
  },
  {
    breaks: "writes a row whose revision predicate missed",
    apply: everywhere((operations) => ({
      ...operations,
      tasks: {
        ...operations.tasks,
        update: async (task) => {
          await operations.tasks.update(task, (await operations.tasks.get(task.scopeId, task.id))?.revision ?? 0)
          return true
        },
      },
    })),
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
]

describe("tasks store conformance", () => {
  const cases = tasksStoreConformance(async () => ({ store: createMemoryTasksStore() }))

  test("the pinned manifest lists exactly the cases the suite runs", () => {
    expect(TASKS_STORE_CONFORMANCE_VERSION).toBe(1)
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
