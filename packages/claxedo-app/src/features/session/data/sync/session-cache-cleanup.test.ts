import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { clearAllPromptSessionStatusTimeoutsForTest, dispatchSessionStatusEvent } from "../../store/session-status-dispatcher"
import { queryKeys } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { setSessionStatusQueryData } from "./queries"
import { clearOpenSessions, setOpenSessions } from "@/features/session/store/open-sessions"
import { cleanupDroppedSessionCaches, cleanupSessionCaches, droppedSessionIDs } from "./session-cache-cleanup"

const root = (id: string, time = 1) =>
  ({
    id,
    time: {
      created: time,
      updated: time,
    },
  }) as Session

beforeEach(() => clearOpenSessions())
afterEach(() => {
  clearOpenSessions()
  queryClient.clear()
  clearAllPromptSessionStatusTimeoutsForTest()
})

describe("session cache cleanup", () => {
  test("derives stale session ids from previous and next session lists", () => {
    expect(droppedSessionIDs([root("sess_1"), root("sess_2")], [root("sess_2")])).toEqual(["sess_1"])
  })

  test("clears shell query records for dropped idle sessions", () => {
    queryClient.setQueryData(shellDataKeys.sessionId("sess_1", "todo"), [{ id: "todo_1" }])
    queryClient.setQueryData(shellDataKeys.sessionId("sess_2", "todo"), [{ id: "todo_2" }])

    cleanupDroppedSessionCaches([root("sess_1"), root("sess_2")], [root("sess_2")], "/tmp/ws")

    expect(queryClient.getQueryData(shellDataKeys.sessionId("sess_1", "todo"))).toBeUndefined()
    expect(queryClient.getQueryData(shellDataKeys.sessionId("sess_2", "todo"))).toEqual([{ id: "todo_2" }])
  })

  test("keeps shell query records for open sessions outside the trimmed list by session id", () => {
    setOpenSessions([{ directory: "/tmp/other", sessionId: "sess_open" }])
    queryClient.setQueryData(shellDataKeys.sessionId("sess_open", "todo"), [{ id: "todo_open" }])

    cleanupDroppedSessionCaches([root("sess_open")], [root("sess_keep")], "/tmp/ws")

    expect(queryClient.getQueryData(shellDataKeys.sessionId("sess_open", "todo"))).toEqual([{ id: "todo_open" }])
  })

  test("keeps just-active non-idle sessions while status registration catches up", () => {
    dispatchSessionStatusEvent({
      event: {
        type: "session.status",
        source: "optimistic",
        sessionID: "sess_busy",
        status: { type: "busy" },
      },
    })
    queryClient.setQueryData(shellDataKeys.sessionId("sess_busy", "todo"), [{ id: "todo_busy" }])

    cleanupDroppedSessionCaches([root("sess_busy")], [root("sess_keep")], "/tmp/ws")

    expect(queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId("sess_busy", "status"))).toEqual({
      type: "busy",
    })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("sess_busy", "todo"))).toEqual([{ id: "todo_busy" }])
  })

  test("keeps non-idle sessions using directory session cache recency", () => {
    setSessionStatusQueryData({ queryClient, sessionId: "sess_cache_busy", status: { type: "busy" } })
    queryClient.setQueryData(shellDataKeys.sessionId("sess_cache_busy", "todo"), [{ id: "todo_busy" }])
    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/ws"), {
      at: Date.now(),
      limit: 40,
      total: 1,
      session: [root("sess_cache_busy", Date.now())],
    })

    cleanupDroppedSessionCaches([root("sess_cache_busy")], [root("sess_keep")], "/tmp/ws")

    expect(queryClient.getQueryData(shellDataKeys.sessionId("sess_cache_busy", "todo"))).toEqual([{ id: "todo_busy" }])
  })

  test("clears a single session shell cache on archive or delete", () => {
    queryClient.setQueryData(shellDataKeys.sessionId("sess_deleted", "todo"), [{ id: "todo_deleted" }])

    cleanupSessionCaches("sess_deleted")

    expect(queryClient.getQueryData(shellDataKeys.sessionId("sess_deleted", "todo"))).toBeUndefined()
  })
})
