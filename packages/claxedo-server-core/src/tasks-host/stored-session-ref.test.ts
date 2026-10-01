import { describe, expect, test } from "vitest"
import { linkRow, taskRow } from "@claxedo/tasks/test-support"
import { linkColumns, linkOfColumns, taskColumns, taskOfColumns, TasksStoredRowError } from "./stored-rows"

const ref = { sessionId: "session-1", workspaceId: "workspace-1" }

describe("stored Tasks session identity", () => {
  test("a stored reference missing either half is refused, and one missing both is absent", () => {
    const task = taskColumns(taskRow({ id: "task-1", createdFrom: ref }))
    expect(taskOfColumns(task).createdFrom).toEqual(ref)
    expect(() => taskOfColumns({ ...task, created_from_workspace_id: null })).toThrow(TasksStoredRowError)
    const link = linkColumns(linkRow({ taskId: "task-1", attempt: 1, sessionRef: ref, continuedFrom: ref, startedFrom: ref }))
    for (const field of ["session_workspace_id", "continued_from_workspace_id", "started_from_session_id"] as const) {
      expect(() => linkOfColumns({ ...link, [field]: null })).toThrow(TasksStoredRowError)
    }
    expect(linkOfColumns(linkColumns(linkRow({ taskId: "task-1", attempt: 1, sessionRef: ref })))).toMatchObject({ continuedFrom: null, startedFrom: null })
  })
})
