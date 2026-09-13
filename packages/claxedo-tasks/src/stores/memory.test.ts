import { describe, expect, test } from "bun:test"
import { tasksCommandReplayConformance } from "../conformance/commands"
import { CONFORMANCE_SCOPES, tasksStoreConformance } from "../conformance/store"
import { createMemoryTasksStore } from "./memory"

describe("memory tasks store", () => {
  for (const conformanceCase of tasksStoreConformance(async () => ({ store: createMemoryTasksStore() }))) {
    test(conformanceCase.name, async () => {
      await conformanceCase.run()
    })
  }

  for (const conformanceCase of tasksCommandReplayConformance(async () => ({ store: createMemoryTasksStore() }))) {
    test(conformanceCase.name, async () => {
      await conformanceCase.run()
    })
  }

  test("a caller that mutates a row it read cannot reach the stored one", async () => {
    const store = createMemoryTasksStore()
    await store.tasks.insert({
      id: "task-1",
      revision: 1,
      scopeId: CONFORMANCE_SCOPES.first,
      projectId: "project-alpha",
      number: 1,
      workspaceId: null,
      parentTaskId: null,
      title: "Original",
      description: "",
      status: "todo",
      childSetRevision: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    })

    const read = await store.tasks.get(CONFORMANCE_SCOPES.first, "task-1")
    expect(read).toBeDefined()
    if (read) {
      read.title = "Rewritten"
      read.status = "done"
    }
    expect((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-1"))?.title).toBe("Original")
    expect((await store.tasks.get(CONFORMANCE_SCOPES.first, "task-1"))?.status).toBe("todo")
  })
})
