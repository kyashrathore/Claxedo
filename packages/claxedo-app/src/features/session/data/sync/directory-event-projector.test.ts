import { afterEach, describe, expect, test } from "bun:test"
import type { AgentPermission as PermissionRequest, AgentQuestion as QuestionRequest, AgentPresentationSession as Session, AgentSnapshotFileDiff as SnapshotFileDiff, AgentTodo as Todo } from "@claxedo/agent-runtime-contract"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { applyDirectoryEventToShellQueries } from "./directory-event-projector"
import { shellDataKeys } from "@/platform/sync/keys"

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

  test("non-archived updates rename the cached list row without clearing session resources", () => {
    const key = queryKeys.shell.sessionList(undefined, { scope: "workspace", directory: "/tmp/ws" })
    queryClient.setQueryData(key, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 50 },
      items: [{ sessionId: "ses_created", directory: "/tmp/ws", title: "Before", updatedAt: 1 }],
    })
    queryClient.setQueryData(shellDataKeys.sessionId("ses_created", "todo"), [{ id: "todo_1" }])

    apply({ type: "session.updated", properties: { info: { ...root("ses_created"), title: "Renamed" } } })

    expect(queryClient.getQueryData(key)).toMatchObject({ items: [{ sessionId: "ses_created", title: "Renamed" }] })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_created", "todo"))).toEqual([{ id: "todo_1" }])
  })

  test("archives remove shell session queries", () => {
    queryClient.setQueryData(shellDataKeys.sessionId("ses_query", "todo"), [{ id: "todo_1" }])

    apply({ type: "session.updated", properties: { info: root("ses_query", Date.now()) } })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "todo"))).toBeUndefined()
  })

  // Nothing the agent side of the stream reports may move a row: the list orders
  // on the reader's own last message, which only the submit path writes.
  test.each(["message.completed", "session.idle", "session.status"])(
    "%s does not move the session it names",
    (type) => {
      const key = queryKeys.shell.sessionList(undefined, { scope: "workspace", directory: "/tmp/ws", archived: "active", sort: "human_turn_desc", limit: 50, groupBy: "none" })
      queryClient.setQueryData(key, {
        view: { scope: "workspace", groupBy: "none", sort: "human_turn_desc", limit: 50 },
        items: [
          { sessionId: "ses_b", directory: "/tmp/ws", createdAt: 20, updatedAt: 200, lastHumanTurnAt: 200, type: "session", sessionRef: "local:/tmp/ws:session:ses_b", tags: [], attachments: [] },
          { sessionId: "ses_a", directory: "/tmp/ws", createdAt: 10, updatedAt: 100, lastHumanTurnAt: 100, type: "session", sessionRef: "local:/tmp/ws:session:ses_a", tags: [], attachments: [] },
        ],
      })

      apply({ type, properties: { sessionID: "ses_a" } })

      const next = queryClient.getQueryData<{ items: Array<{ sessionId: string; lastHumanTurnAt?: number }> }>(key)
      expect(next?.items?.map((row) => row.sessionId)).toEqual(["ses_b", "ses_a"])
      expect(next?.items?.find((row) => row.sessionId === "ses_a")?.lastHumanTurnAt).toBe(100)
    },
  )
})
