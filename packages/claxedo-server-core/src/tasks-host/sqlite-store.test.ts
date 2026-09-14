/**
 * SQLite side of `tasksStoreConformance`, the kit-owned suite every durable
 * Tasks adapter runs. A divergence here is a divergence in what a revision
 * predicate, a claimed session origin or a scope means on one of the products.
 */
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { afterAll, describe, expect, test } from "vitest"
import { presetRow, taskRow, SCOPES } from "@claxedo/tasks/test-support"
import type { Task } from "@claxedo/tasks"

const roots: string[] = []
const previousDataDir = process.env.CLAXEDO_DATA_DIR

const { ClaxedoDB } = await import("../platform/db/index")
const { sqliteTasksStore } = await import("./sqlite-store")
const { TasksStoredRowError } = await import("./stored-rows")
const { tasksStoreConformance, tasksCommandReplayConformance } = await import("@claxedo/tasks/conformance")

/**
 * A fresh database file per case, rather than a DELETE sweep between them: the
 * conformance suite asserts an empty store at the start of every case, and a
 * store that is empty because the last case's rows were deleted would not
 * exercise the migration that creates these tables.
 */
function freshDatabase() {
  ClaxedoDB.close()
  const root = path.join(realpathSync(os.tmpdir()), `tasks-sqlite-store-${randomUUID().slice(0, 8)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  process.env.CLAXEDO_DATA_DIR = root
  ClaxedoDB.Drizzle()
}

afterAll(async () => {
  ClaxedoDB.close()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

describe("SQLite TasksStorePort conformance", () => {
  for (const testCase of tasksStoreConformance(async () => {
    freshDatabase()
    return { store: sqliteTasksStore }
  })) {
    test(testCase.name, testCase.run)
  }
})

describe("SQLite Tasks command replay conformance", () => {
  for (const testCase of tasksCommandReplayConformance(async () => {
    freshDatabase()
    return { store: sqliteTasksStore }
  })) {
    test(testCase.name, testCase.run)
  }
})

/** The scope this adapter serves. The kit's builders mint a number per id, which the unique index needs. */
function localTask(id: string): Task {
  return taskRow({ id, scopeId: "local", title: id })
}

function deferred(): { reached: Promise<void>; reach: () => void } {
  let reach = () => {}
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  return { reached, reach }
}

describe("SQLite Tasks store units", () => {
  test("a write from another module survives a Tasks unit that rolls back", async () => {
    freshDatabase()
    await sqliteTasksStore.tasks.insert(localTask("task-anchor"))

    const opened = deferred()
    const release = deferred()
    const refused = sqliteTasksStore.transaction(async (operations) => {
      await operations.tasks.get("local", "task-anchor")
      opened.reach()
      await release.reached
      throw new Error("the unit refused")
    })
    await opened.reached

    // `__claxedo_meta` is the database engine's own row store and no Tasks
    // statement names it, so a row written here through the shared handle is
    // exactly the unrelated write a Tasks rollback must not reach.
    ClaxedoDB.use((db) => db.run(`INSERT INTO __claxedo_meta (key, value) VALUES ('another-module', 'kept')`))
    release.reach()

    await expect(refused).rejects.toThrow("the unit refused")
    expect(ClaxedoDB.use((db) => db.get(`SELECT value FROM __claxedo_meta WHERE key = 'another-module'`))).toEqual({
      value: "kept",
    })
  })

  test("a unit opened while another holds the connection queues behind it", async () => {
    freshDatabase()

    const held = deferred()
    const holding = sqliteTasksStore.transaction(async (operations) => {
      await operations.tasks.insert(localTask("task-holding"))
      await held.reached
    })
    const queued = sqliteTasksStore.transaction(async (operations) => {
      await operations.tasks.insert(localTask("task-queued"))
    })
    held.reach()

    await holding
    await queued
    expect(await sqliteTasksStore.tasks.get("local", "task-holding")).toMatchObject({ id: "task-holding" })
    expect(await sqliteTasksStore.tasks.get("local", "task-queued")).toMatchObject({ id: "task-queued" })
  })

  test("a create that loses the task-number race is the conflict the hosted store reports", async () => {
    freshDatabase()
    await sqliteTasksStore.tasks.insert(localTask("task-holding"))

    const raced = sqliteTasksStore.tasks.insert({
      ...localTask("task-queued"),
      number: localTask("task-holding").number,
    })
    await expect(raced).rejects.toMatchObject({ name: "TasksStoreConflict", kind: "number-taken" })
  })
})

describe("SQLite Tasks store persistence", () => {
  test("rows survive a reopened database", async () => {
    freshDatabase()
    await sqliteTasksStore.tasks.insert(
      taskRow({
        id: "task-persist",
        revision: 3,
        scopeId: "local",
        title: "Survives a restart",
        description: "body",
        status: "doing",
        childSetRevision: 2,
      }),
    )

    ClaxedoDB.close()
    ClaxedoDB.Drizzle()

    expect(await sqliteTasksStore.tasks.get("local", "task-persist")).toMatchObject({
      revision: 3,
      status: "doing",
      childSetRevision: 2,
      description: "body",
    })
  })

  test("a preset's execution and configurations come back as the records they were written from", async () => {
    freshDatabase()
    await sqliteTasksStore.presets.insert(
      presetRow({
        id: "preset-cloud",
        name: "Cloud review",
        instructions: "Read the diff first.",
        execution: {
          placement: "cloud",
          capabilities: {
            mode: "selected",
            plugins: [{ sourceId: "github:claxedo/plugins@main", pluginName: "reviewer" }],
            skills: [{ sourceId: "github:claxedo/plugins@main", skillName: "diff-reading" }],
          },
        },
        configurations: {
          primary: { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "opus" }, effort: "high" },
          review: { harness: { id: "connection-7", access: "connection" }, model: { providerID: "openai", modelID: "gpt" }, effort: null },
        },
      }),
    )

    const stored = await sqliteTasksStore.presets.get(SCOPES.first, "preset-cloud")
    expect(stored?.execution).toEqual({
      placement: "cloud",
      capabilities: {
        mode: "selected",
        plugins: [{ sourceId: "github:claxedo/plugins@main", pluginName: "reviewer" }],
        skills: [{ sourceId: "github:claxedo/plugins@main", skillName: "diff-reading" }],
      },
    })
    expect(stored?.configurations.review).toEqual({
      harness: { id: "connection-7", access: "connection" },
      model: { providerID: "openai", modelID: "gpt" },
      effort: null,
    })
  })

  test("a stored row that no longer decodes is refused instead of read as a record", async () => {
    freshDatabase()
    ClaxedoDB.use((db) =>
      db.run(
        `INSERT INTO claxedo_task (scope_id, task_id, revision, project_id, number, workspace_id, parent_task_id, title, description, status, child_set_revision, archived_at, created_at, updated_at)
         VALUES ('local', 'task-broken', 1, 'project-a', 1, NULL, NULL, 'Broken', '', 'sideways', 0, NULL, 1, 1)`,
      ),
    )
    const refused = await sqliteTasksStore.tasks
      .get("local", "task-broken")
      .then(() => undefined, (error: unknown) => error)
    expect(refused).toBeInstanceOf(TasksStoredRowError)
    expect((refused as Error).message).toMatch(/status/)
  })
})
