/**
 * SQLite side of the shared Tasks store-port conformance suite.
 *
 * The same runner-neutral cases run against the kit's reference adapter
 * (`@claxedo/tasks` stores/memory) and against the hosted D1 store
 * (`@claxedo/server/tasks/d1-store.test.ts`). A divergence here is a divergence
 * in what a revision predicate, a claimed session origin or a scope means on
 * one of the two products.
 */
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { afterAll, describe, expect, test } from "vitest"

const roots: string[] = []
const previousDataDir = process.env.CLAXEDO_DATA_DIR

const { ClaxedoDB } = await import("../platform/db/index")
const { createSqliteTasksStore } = await import("./sqlite-store")
const { tasksStoreConformance, CONFORMANCE_SCOPES } = await import("@claxedo/tasks/conformance")

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
    return { store: createSqliteTasksStore() }
  })) {
    test(testCase.name, testCase.run)
  }
})

describe("SQLite Tasks store persistence", () => {
  test("rows survive a fresh adapter instance and a reopened database", async () => {
    freshDatabase()
    const first = createSqliteTasksStore()
    await first.tasks.insert({
      id: "task-persist",
      revision: 3,
      scopeId: "local",
      projectId: "project-a",
      workspaceId: null,
      parentTaskId: null,
      title: "Survives a restart",
      description: "body",
      status: "doing",
      childSetRevision: 2,
      archivedAt: null,
      createdAt: 10,
      updatedAt: 20,
    })

    ClaxedoDB.close()
    ClaxedoDB.Drizzle()

    const second = createSqliteTasksStore()
    expect(await second.tasks.get("local", "task-persist")).toMatchObject({
      revision: 3,
      status: "doing",
      childSetRevision: 2,
      description: "body",
    })
  })

  test("a preset's execution and configurations come back as the records they were written from", async () => {
    freshDatabase()
    const store = createSqliteTasksStore()
    await store.presets.insert({
      id: "preset-cloud",
      revision: 1,
      scopeId: CONFORMANCE_SCOPES.first,
      ownerId: "owner-a",
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
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    })

    const stored = await store.presets.get(CONFORMANCE_SCOPES.first, "preset-cloud")
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
    const store = createSqliteTasksStore()
    ClaxedoDB.use((db) =>
      db.run(
        `INSERT INTO claxedo_task (scope_id, task_id, revision, project_id, workspace_id, parent_task_id, title, description, status, child_set_revision, archived_at, created_at, updated_at)
         VALUES ('local', 'task-broken', 1, 'project-a', NULL, NULL, 'Broken', '', 'sideways', 0, NULL, 1, 1)`,
      ),
    )
    await expect(store.tasks.get("local", "task-broken")).rejects.toThrow(/status/)
  })
})
