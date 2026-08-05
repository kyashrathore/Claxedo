import { afterEach, describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session, SnapshotFileDiff, Todo } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
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

  test("leaves session list creates and non-archived updates to the directory cache projector", () => {
    apply({ type: "session.created", properties: { info: root("ses_created") } })
    apply({
      type: "session.updated",
      properties: { info: { ...root("ses_created"), title: "Renamed" } },
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_created", "todo"))).toBeUndefined()
  })

  // The rendered rail rows come from the paginated `session-list` query, which
  // the directory session-cache write in `applySessionListEvent` does NOT feed.
  // `event-ingress` already invalidates it for the Claxedo `session.lifecycle`
  // "created" event, but a plain server `session.created` SSE event had no such
  // branch — so a session created outside the in-app submit path stayed
  // invisible in the sidebar until a full app restart. Verified live against a
  // packaged build: `POST /session` emitted `session.created` on `/global/event`
  // with the correct directory envelope, and the row still did not appear.
  test("refetches the paginated session list when a session is created", () => {
    const key = ["shell", "default", "sessionList", { directory: "/tmp/ws" }] as const
    queryClient.setQueryData(key, { session: [], total: 0 })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)

    apply({ type: "session.created", properties: { info: root("ses_created_live") } })

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })

  test("archives remove shell session queries", () => {
    queryClient.setQueryData(shellDataKeys.sessionId("ses_query", "todo"), [{ id: "todo_1" }])

    apply({ type: "session.updated", properties: { info: root("ses_query", Date.now()) } })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "todo"))).toBeUndefined()
  })
})
