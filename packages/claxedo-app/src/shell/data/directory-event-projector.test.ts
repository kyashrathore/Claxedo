import { afterEach, describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session, SnapshotFileDiff, Todo } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "../../shared/query/query-client"
import { applyDirectoryEventToShellQueries } from "./directory-event-projector"
import { shellDataKeys } from "./keys"

const root = (id: string, archived?: number) =>
  ({
    id,
    time: {
      created: 1,
      updated: 1,
      archived,
    },
  }) as Session

const apply = (event: { type: string; properties?: unknown }) =>
  applyDirectoryEventToShellQueries({ event, directory: "/tmp/ws" })

afterEach(() => {
  queryClient.clear()
})

describe("directory event shell query projector", () => {
  test("projects diff and todo events into shell session queries", () => {
    const diff = [
      { file: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, hunks: [] },
    ] as SnapshotFileDiff[]
    const todos = [{ id: "todo_1", content: "Ship it", status: "pending" }] as Todo[]

    apply({ type: "session.diff", properties: { sessionID: "ses_query", diff } })
    apply({ type: "todo.updated", properties: { sessionID: "ses_query", todos } })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "diff"))).toEqual(diff)
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "todo"))).toEqual(todos)
  })

  test("projects permission and question events into shell request query", () => {
    const permission = {
      id: "perm_1",
      sessionID: "ses_query",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    } as PermissionRequest
    const question = {
      id: "question_1",
      sessionID: "ses_query",
      questions: [],
    } as QuestionRequest

    apply({ type: "permission.asked", properties: permission })
    apply({ type: "question.asked", properties: question })
    apply({
      type: "permission.asked",
      properties: { ...permission, metadata: { replacement: true } },
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "requests"))).toEqual({
      permissions: [{ ...permission, metadata: { replacement: true } }],
      questions: [question],
    })

    apply({ type: "permission.replied", properties: { sessionID: "ses_query", requestID: permission.id } })
    apply({ type: "question.rejected", properties: { sessionID: "ses_query", requestID: question.id } })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "requests"))).toEqual({
      permissions: [],
      questions: [],
    })
  })

  test("removes shell session queries when a session is deleted", () => {
    queryClient.setQueryData(shellDataKeys.sessionId("ses_query", "todo"), [{ id: "todo_1" }])

    apply({ type: "session.deleted", properties: { info: root("ses_query") } })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "todo"))).toBeUndefined()
  })

  test("leaves session list creates and non-archived updates to the directory cache projector", () => {
    apply({ type: "session.created", properties: { info: root("ses_created") } })
    apply({
      type: "session.updated",
      properties: { info: { ...root("ses_created"), title: "Renamed" } },
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_created", "todo"))).toBeUndefined()
  })

  test("archives remove shell session queries", () => {
    queryClient.setQueryData(shellDataKeys.sessionId("ses_query", "todo"), [{ id: "todo_1" }])

    apply({ type: "session.updated", properties: { info: root("ses_query", Date.now()) } })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "todo"))).toBeUndefined()
  })
})
