import { describe, expect, test } from "bun:test"
import { skipToken } from "@tanstack/solid-query"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  dbReadyQuery,
  directorySessionCacheQueryOptions,
  sessionDiffQueryOptions,
  sessionQueryOptions,
  sessionRequestsQueryOptions,
  sessionRequestsCacheQueryOptions,
  sessionStatusQueryOptions,
  sessionStatusCacheQueryOptions,
  setSessionDiffQueryData,
  setSessionRequestsQueryData,
  setSessionStatusQueryData,
  setSessionTodoQueryData,
  sessionTodoQueryOptions,
  sessionTodoCacheQueryOptions,
  workspaceQueryOptions,
} from "./queries"
import type { SessionRef } from "@/platform/identity/session-ref"

const ref: SessionRef = {
  sessionId: "ses_shell",
  host: "central",
  workspaceId: "ws_authz",
  toolSandbox: { kind: "virtual" },
  cwd: "/tmp/ignored",
}

describe("shell data query factories", () => {
  test("session keys scope only by opaque session id", async () => {
    const query = sessionQueryOptions({
      ref,
      resource: "messages",
      params: ["head"],
      staleTime: 1000,
      queryFn: async () => "ok",
    })

    expect(query.queryKey).toEqual(["shell", "session", "ses_shell", "messages", "head"])
    expect(query.staleTime).toBe(1000)
    expect(await query.queryFn()).toBe("ok")
  })

  test("session id keys do not require placement identity", () => {
    expect(shellDataKeys.sessionId("ses_shell", "row")).toEqual(["shell", "session", "ses_shell", "row"])
  })

  test("workspace keys are explicitly workspace-scoped", async () => {
    const query = workspaceQueryOptions({
      workspaceId: "ws_real",
      resource: "vcs",
      queryFn: async () => ({ branch: "dev" }),
    })

    expect(query.queryKey).toEqual(["shell", "workspace", "ws_real", "vcs"])
    expect(await query.queryFn()).toEqual({ branch: "dev" })
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
    expect(() => shellDataKeys.workspaceForSession({ sessionId: "ses_no_ws", host: "central" }, "inventory"))
      .toThrow("workspace-scoped query requires workspaceId")
  })

  test("dbReadyQuery preserves branded key shape for later TanStack DB wrapping", async () => {
    const query = dbReadyQuery({
      queryKey: shellDataKeys.session(ref, "metadata"),
      queryFn: async () => ({ title: "Shell" }),
    })

    expect(query.queryKey).toEqual(["shell", "session", "ses_shell", "metadata"])
    expect(await query.queryFn()).toEqual({ title: "Shell" })
  })

  test("sessionStatusQueryOptions scopes by session id and falls back to idle", async () => {
    const query = sessionStatusQueryOptions({
      sessionId: "ses_shell",
      client: {
        session: {
          status: async () => ({ data: { other: { type: "busy" } } }),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "session", "ses_shell", "status"])
    expect(await query.queryFn()).toEqual({ type: "idle" })
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

  test("sessionRequestsQueryOptions filters permission and question lists by session id", async () => {
    const query = sessionRequestsQueryOptions({
      sessionId: "ses_shell",
      client: {
        permission: {
          list: async () => ({
            data: [
              { id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] },
              { id: "perm_2", sessionID: "other", permission: "edit", patterns: [], metadata: {}, always: [] },
            ],
          }),
        },
        question: {
          list: async () => ({
            data: [
              { id: "question_1", sessionID: "ses_shell", questions: [] },
              { id: "question_2", sessionID: "other", questions: [] },
            ],
          }),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "session", "ses_shell", "requests"])
    expect(await query.queryFn()).toEqual({
      permissions: [{ id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] }],
      questions: [{ id: "question_1", sessionID: "ses_shell", questions: [] }],
    })
  })

  test("setSessionRequestsQueryData writes through the session-scoped requests key", () => {
    const writes: Array<{ queryKey: readonly unknown[]; value: unknown }> = []
    setSessionRequestsQueryData({
      queryClient: {
        setQueryData: (queryKey, value) => {
          writes.push({ queryKey, value })
        },
      },
      sessionId: "ses_shell",
      requests: {
        permissions: [{ id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] }],
        questions: [{ id: "question_1", sessionID: "ses_shell", questions: [] }],
      },
    })

    expect(writes).toEqual([{
      queryKey: ["shell", "session", "ses_shell", "requests"],
      value: {
        permissions: [{ id: "perm_1", sessionID: "ses_shell", permission: "edit", patterns: [], metadata: {}, always: [] }],
        questions: [{ id: "question_1", sessionID: "ses_shell", questions: [] }],
      },
    }])
  })

  test("sessionTodoQueryOptions scopes by session id and falls back to an empty list", async () => {
    const query = sessionTodoQueryOptions({
      sessionId: "ses_shell",
      client: {
        session: {
          todo: async () => ({}),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "session", "ses_shell", "todo"])
    expect(query.staleTime).toBe(30_000)
    expect(await query.queryFn()).toEqual([])
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

  test("sessionDiffQueryOptions scopes by session id and falls back to an empty list", async () => {
    const query = sessionDiffQueryOptions({
      sessionId: "ses_shell",
      client: {
        session: {
          diff: async () => ({}),
        },
      },
    })

    expect(query.queryKey).toEqual(["shell", "session", "ses_shell", "diff"])
    expect(query.staleTime).toBe(30_000)
    expect(await query.queryFn()).toEqual([])
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
