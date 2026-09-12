/**
 * D1 side of the shared Tasks store-port conformance suite, plus the two
 * properties only this adapter has to prove: that a unit of work really does
 * commit as one batch, and that a row which moved between the read that
 * decided a write and the batch that carries it takes the whole batch down
 * instead of committing a lost update.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import { tasksStoreConformance, CONFORMANCE_SCOPES } from "@claxedo/tasks/conformance"
import type { Task } from "@claxedo/tasks"

import { createD1TasksStore } from "./d1-store"

// 0024 owns every table under test and references no auth table, so it is the
// only migration this store needs. The real file runs — a hand-written schema
// here would prove the store works against a table that does not ship.
const MIGRATIONS = ["0024_claxedo_tasks.sql"]

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

function taskRow(input: Partial<Task> & Pick<Task, "id">): Task {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scopeId: input.scopeId ?? CONFORMANCE_SCOPES.first,
    projectId: input.projectId ?? "project-alpha",
    workspaceId: input.workspaceId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    title: input.title ?? "Guarded task",
    description: input.description ?? "",
    status: input.status ?? "todo",
    childSetRevision: input.childSetRevision ?? 0,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  }
}

describe("D1 TasksStorePort conformance", () => {
  for (const testCase of tasksStoreConformance(async () => ({ store: createD1TasksStore({ database: await database() }) }))) {
    test(testCase.name, testCase.run)
  }
})

describe("D1 Tasks store units", () => {
  test("a revision that moves between the read and the batch takes the whole batch down", async () => {
    const target = await database()
    const store = createD1TasksStore({ database: target })
    await store.tasks.insert(taskRow({ id: "task-guarded", revision: 1 }))

    const refused = store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-child", parentTaskId: "task-guarded" }))
      expect(await tx.tasks.update(taskRow({ id: "task-guarded", revision: 2, title: "Mine" }), 1)).toBe(true)
      // Another writer commits between this unit's read and its batch.
      await target
        .prepare("update tasks set revision = 7, title = 'Theirs' where scope_id = ? and task_id = ?")
        .bind(CONFORMANCE_SCOPES.first, "task-guarded")
        .run()
    })

    await expect(refused).rejects.toThrow()
    expect(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-guarded")).toMatchObject({ revision: 7, title: "Theirs" })
    expect(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-child")).toBeUndefined()
    const guards = await target.prepare("select count(*) as rows from task_write_guards").first<{ rows: number }>()
    expect(guards?.rows).toBe(0)
  })

  test("a unit reads the rows it has written but not yet committed", async () => {
    const store = createD1TasksStore({ database: await database() })
    await store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-pending", revision: 1 }))
      expect(await tx.tasks.get(CONFORMANCE_SCOPES.first, "task-pending")).toMatchObject({ id: "task-pending" })
      expect(await tx.tasks.update(taskRow({ id: "task-pending", revision: 2, title: "Renamed" }), 1)).toBe(true)
    })
    expect(await store.tasks.get(CONFORMANCE_SCOPES.first, "task-pending")).toMatchObject({ revision: 2, title: "Renamed" })
  })

  test("a list read after a write inside one unit is refused rather than answered from committed rows", async () => {
    const store = createD1TasksStore({ database: await database() })
    const refused = store.transaction(async (tx) => {
      await tx.tasks.insert(taskRow({ id: "task-listed", parentTaskId: "task-parent" }))
      await tx.tasks.countChildren(CONFORMANCE_SCOPES.first, "task-parent", { includeArchived: true, excludeStatus: null })
    })
    await expect(refused).rejects.toThrow(/already written rows/)
  })
})
