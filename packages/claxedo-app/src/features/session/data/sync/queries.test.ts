import { describe, expect, test } from "bun:test"
import { skipToken } from "@tanstack/solid-query"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  directorySessionCacheQueryOptions,
  sessionRequestsCacheQueryOptions,
  sessionStatusCacheQueryOptions,
  setSessionDiffQueryData,
  setSessionRequestsQueryData,
  setSessionStatusQueryData,
  setSessionTodoQueryData,
  sessionTodoCacheQueryOptions,
} from "./queries"
import type { SessionRef } from "@/platform/identity/session-ref"

const ref: SessionRef = {
  sessionId: "ses_shell",
  host: "workspace",
  workspaceId: "ws_authz",
  toolSandbox: { kind: "workspace", workspaceId: "ws_authz" },
  cwd: "/tmp/ignored",
}

describe("shell data query factories", () => {
  test("session id keys do not require placement identity", () => {
    expect(shellDataKeys.sessionId("ses_shell", "row")).toEqual(["shell", "session", "ses_shell", "row"])
  })

  test("directorySessionCacheQueryOptions reads the global-sync session cache key", () => {
    const query = directorySessionCacheQueryOptions({ directory: "/tmp/workspace" })

    expect(query.queryKey).toEqual(["directory", "local", "sessionCache", "/tmp/workspace"])
  })

  test("workspaceForSession accepts authz scope without implying backing", () => {
    expect(shellDataKeys.workspaceForSession(ref, "inventory")).toEqual([
      "shell",
      "workspace",
      "ws_authz",
      "inventory",
    ])
    expect(() => shellDataKeys.workspaceForSession({ sessionId: "ses_no_ws", host: "workspace" }, "inventory"))
      .toThrow("workspace-scoped query requires workspaceId")
  })

  test("push-owned session cache readers install no transport queryFn", () => {
    const readers = [
      sessionStatusCacheQueryOptions({ sessionId: "ses_shell" }),
      sessionRequestsCacheQueryOptions({ sessionId: "ses_shell" }),
      sessionTodoCacheQueryOptions({ sessionId: "ses_shell" }),
    ]

    expect(readers.map((query) => query.queryKey)).toEqual([
      ["shell", "session", "ses_shell", "status"],
      ["shell", "session", "ses_shell", "requests"],
      ["shell", "session", "ses_shell", "todo"],
    ])
    expect(readers.every((query) => query.queryFn === skipToken)).toBe(true)
    expect(readers.every((query) => query.enabled === false)).toBe(true)
  })

  test("setSessionStatusQueryData writes through the session-scoped status key", () => {
    const writes: Array<{ queryKey: readonly unknown[]; value: unknown }> = []
    setSessionStatusQueryData({
      queryClient: {
        setQueryData: (queryKey, value) => {
          writes.push({
            queryKey,
            value: typeof value === "function" ? value(undefined) : value,
          })
        },
      },
      sessionId: "ses_shell",
      status: { type: "busy" },
    })

    expect(writes).toEqual([{
      queryKey: ["shell", "session", "ses_shell", "status"],
      value: { type: "busy" },
    }])
  })

  test("setSessionStatusQueryData preserves the previous object for identical replayed status", () => {
    const previous = { type: "busy" as const }
    const writes: unknown[] = []
    setSessionStatusQueryData({
      queryClient: {
        setQueryData: (_queryKey, value) => {
          writes.push(typeof value === "function" ? value(previous) : value)
        },
      },
      sessionId: "ses_shell",
      status: { type: "busy" },
    })

    expect(writes[0]).toBe(previous)
  })

  test("setSessionRequestsQueryData writes through the session-scoped requests key", () => {
    const writes: Array<{ queryKey: readonly unknown[]; value: unknown }> = []
    setSessionRequestsQueryData({
      queryClient: {
        setQueryData: (queryKey, value) => {
          writes.push({ queryKey, value: typeof value === "function" ? value(undefined) : value })
        },
      },
      sessionId: "ses_shell",
      requests: {
        permissions: [{ id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] }],
        questions: [{ id: "question_1", sessionID: "ses_shell", questions: [] }],
      },
    })

    // The resolved-request ledger this writer keeps beside the entry is offered
    // the same session scope; with no previous ledger it writes nothing.
    expect(writes).toEqual([{
      queryKey: ["shell", "session", "ses_shell", "resolved-requests"],
      value: undefined,
    }, {
      queryKey: ["shell", "session", "ses_shell", "requests"],
      value: {
        permissions: [{ id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] }],
        questions: [{ id: "question_1", sessionID: "ses_shell", questions: [] }],
      },
    }])
  })

  // Reference preservation only — a cache event still fires. Matches the
  // status writer's contract directly above.
  test("setSessionRequestsQueryData preserves the previous object for identical replayed requests", () => {
    const previous = {
      permissions: [{ id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] }],
      questions: [{ id: "question_1", sessionID: "ses_shell", questions: [] }],
    }
    const writes: unknown[] = []
    setSessionRequestsQueryData({
      queryClient: {
        setQueryData: (queryKey, value) => {
          if (queryKey[3] !== "requests") return
          writes.push(typeof value === "function" ? value(previous) : value)
        },
      },
      sessionId: "ses_shell",
      requests: structuredClone(previous),
    })

    expect(writes[0]).toBe(previous)
  })

  test("setSessionRequestsQueryData writes the new list when a permission is added", () => {
    const previous = { permissions: [], questions: [] }
    const writes: unknown[] = []
    const next = {
      permissions: [{ id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] }],
      questions: [],
    }
    setSessionRequestsQueryData({
      queryClient: {
        setQueryData: (queryKey, value) => {
          if (queryKey[3] !== "requests") return
          writes.push(typeof value === "function" ? value(previous) : value)
        },
      },
      sessionId: "ses_shell",
      requests: next,
    })

    expect(writes[0]).toBe(next)
  })

  test("setSessionTodoQueryData writes through the session-scoped todo key", () => {
    const writes: Array<{ queryKey: readonly unknown[]; value: unknown }> = []
    const todos = [{ id: "todo_1", sessionID: "ses_shell", messageID: "msg_1", content: "Check", status: "pending" }]
    setSessionTodoQueryData({
      queryClient: {
        setQueryData: (queryKey, value) => {
          writes.push({
            queryKey,
            value: typeof value === "function" ? value(undefined) : value,
          })
        },
      },
      sessionId: "ses_shell",
      todos,
    })

    expect(writes).toEqual([{
      queryKey: ["shell", "session", "ses_shell", "todo"],
      value: todos,
    }])
  })

  test("setSessionTodoQueryData preserves the previous array for identical replayed todos", () => {
    const previous = [{ id: "todo_1", sessionID: "ses_shell", messageID: "msg_1", content: "Check", status: "pending" }]
    const writes: unknown[] = []
    setSessionTodoQueryData({
      queryClient: {
        setQueryData: (_queryKey, value) => {
          writes.push(typeof value === "function" ? value(previous) : value)
        },
      },
      sessionId: "ses_shell",
      todos: [{ id: "todo_1", sessionID: "ses_shell", messageID: "msg_1", content: "Check", status: "pending" }],
    })

    expect(writes[0]).toBe(previous)
  })

  test("setSessionDiffQueryData writes through the session-scoped diff key", () => {
    const writes: Array<{ queryKey: readonly unknown[]; value: unknown }> = []
    setSessionDiffQueryData({
      queryClient: {
        setQueryData: (queryKey, value) => {
          writes.push({ queryKey, value })
        },
      },
      sessionId: "ses_shell",
      diff: [{ file: "README.md", status: "added", additions: 1, deletions: 0 }],
    })

    expect(writes).toEqual([{
      queryKey: ["shell", "session", "ses_shell", "diff"],
      value: [{ file: "README.md", status: "added", additions: 1, deletions: 0 }],
    }])
  })

})
