import { describe, expect, test } from "vitest"
import { linkRow, taskRow } from "@claxedo/tasks/test-support"
import { linkColumns, linkOfColumns, taskColumns, taskOfColumns, TasksStoredRowError } from "./stored-rows"

const ref = { sessionId: "session-1", workspaceId: "workspace-1" }

describe("stored Tasks session identity", () => {
  test("task provenance rejects either half of the stored pair", () => {
    const columns = taskColumns(taskRow({ id: "task-1", createdFrom: ref }))
    expect(taskOfColumns(columns).createdFrom).toEqual(ref)
    expect(() => taskOfColumns({ ...columns, created_from_workspace_id: null })).toThrow(TasksStoredRowError)
    expect(() => taskOfColumns({ ...columns, created_from_session_id: null })).toThrow(TasksStoredRowError)
  })

  test("every link reference rejects a session without its workspace", () => {
    const columns = linkColumns(linkRow({ taskId: "task-1", attempt: 1, sessionRef: ref, continuedFrom: ref, startedFrom: ref }))
    expect(linkOfColumns(columns).sessionRef).toEqual(ref)
    for (const field of ["session_workspace_id", "continued_from_workspace_id", "started_from_workspace_id"] as const) {
      expect(() => linkOfColumns({ ...columns, [field]: null })).toThrow(TasksStoredRowError)
    }
  })

  test("optional link references reject a workspace without its session", () => {
    const columns = linkColumns(linkRow({ taskId: "task-1", attempt: 1, sessionRef: ref, continuedFrom: ref, startedFrom: ref }))
    for (const field of ["continued_from_session_id", "started_from_session_id"] as const) {
      expect(() => linkOfColumns({ ...columns, [field]: null })).toThrow(TasksStoredRowError)
    }
    expect(linkOfColumns(linkColumns(linkRow({ taskId: "task-1", attempt: 1, sessionRef: ref })))).toMatchObject({ continuedFrom: null, startedFrom: null })
  })
})
