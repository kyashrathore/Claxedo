import { describe, expect, test } from "bun:test"
import type { Task } from "@claxedo/tasks"
import { TasksApiError } from "@claxedo/tasks/client"
import { refusalOf } from "../data/tasks-api"
import { createTasksStore } from "./tasks-store"

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    revision: 3,
    scopeId: "local",
    projectId: "prj_1",
    workspaceId: null,
    number: 1,
    parentTaskId: null,
    title: "Ship the importer",
    description: "",
    status: "todo",
    childSetRevision: 0,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("tasks store drafts", () => {
  test("a stale revision rebases the expected revision and keeps every edited character", () => {
    const store = createTasksStore()
    const original = task()
    store.setEditDraft(original.id, { title: "Ship the importer, carefully", description: "mine", revision: 3 })

    const server = task({ revision: 7, title: "Renamed elsewhere", description: "theirs" })
    store.refuseTaskEdit(
      original.id,
      refusalOf(
        new TasksApiError(409, "stale_revision", {
          code: "stale_revision",
          message: "Task changed",
          currentTask: server,
        }),
      ),
    )

    const draft = store.editDraft(server)
    expect(draft.title).toBe("Ship the importer, carefully")
    expect(draft.description).toBe("mine")
    expect(draft.revision).toBe(7)
    expect(store.state.taskConflicts[original.id]).toContain("Renamed elsewhere")
    expect(store.state.taskErrors[original.id]).toBeUndefined()
  })

  test("a refusal that is not a conflict is reported without touching the draft", () => {
    const store = createTasksStore()
    const original = task()
    store.setEditDraft(original.id, { title: "Edited", description: "", revision: 3 })

    store.refuseTaskEdit(
      original.id,
      refusalOf(new TasksApiError(403, "forbidden", { code: "forbidden", message: "No write access" })),
    )

    expect(store.editDraft(original).title).toBe("Edited")
    expect(store.state.taskErrors[original.id]).toBe("No write access")
    expect(store.state.taskConflicts[original.id]).toBeUndefined()
  })

  test("a successful save drops the draft so the server record owns the fields again", () => {
    const store = createTasksStore()
    store.setEditDraft("tsk_1", { title: "Edited", description: "", revision: 3 })

    store.taskSaved("tsk_1")

    expect(store.editDraft(task()).title).toBe("Ship the importer")
  })

  test("collections split the catalog by status without dropping archived rows from All", () => {
    const store = createTasksStore()
    const rows = [
      { ...task({ id: "a", status: "todo" }), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } },
      { ...task({ id: "b", status: "doing" }), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } },
      { ...task({ id: "c", status: "done" }), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } },
      { ...task({ id: "d", status: "todo", archivedAt: 10 }), hasDescription: false, links: { count: 0 }, children: { total: 0, done: 0 } },
    ].map(({ description: _description, ...rest }) => rest)

    expect(store.visibleTasks(rows).map((row) => row.id)).toEqual(["a", "b"])
    store.setCollection("backlog")
    expect(store.visibleTasks(rows).map((row) => row.id)).toEqual(["a"])
    store.setCollection("all")
    expect(store.visibleTasks(rows).map((row) => row.id)).toEqual(["a", "b", "c", "d"])
  })
})
