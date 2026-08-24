import { afterEach, describe, expect, test } from "bun:test"
import { QueryObserver } from "@tanstack/solid-query"
import type { PermissionRequest, Session, Todo } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"
import { conversationEventTypes } from "../../../features/session/conversation/conversation-event"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  classifyStreamEvent,
  routeDirectoryEvent,
  type DirectoryEventRouterSinks,
  type RoutableEvent,
} from "./event-router"
import { sessionTodoQueryOptions, type DirectorySessionCacheValue } from "../../../features/session/data/sync/queries"

function event(type: string, properties: Record<string, unknown> = {}): RoutableEvent {
  return { type, properties }
}

const root = (id: string) =>
  ({
    id,
    time: {
      created: 1,
      updated: 1,
    },
  }) as Session

function routerSinks(
  input: {
    cache?: DirectorySessionCacheValue
    directory?: string
    schedules?: RoutableEvent[]
    marks?: string[]
  } = {},
): DirectoryEventRouterSinks & { cacheValue: () => DirectorySessionCacheValue } {
  const directory = input.directory ?? "/tmp/ws"
  let cache = input.cache ?? {
    at: 1,
    limit: 10,
    total: 0,
    session: [],
  }
  return {
    cache: () => cache,
    cacheValue: () => cache,
    cacheSessions: (next) => {
      cache = next
      queryClient.setQueryData(queryKeys.directory.sessionCache(directory), next)
    },
    push: () => {},
    schedule: (next) => input.schedules?.push(next),
    mark: () => input.marks?.push("marked"),
  }
}

afterEach(() => {
  queryClient.clear()
})

describe("directory event router", () => {
  test("classifies conversation, targeted, and coarse events", () => {
    expect(
      classifyStreamEvent(
        event("message.part.delta", {
          sessionID: "ses_1",
          partID: "part_1",
          text: "hello",
        }),
      ),
    ).toMatchObject({
      type: "conversation",
      sessionId: "ses_1",
    })

    expect(
      classifyStreamEvent(
        event("permission.asked", {
          id: "perm_1",
          sessionID: "ses_1",
        }),
      ),
    ).toMatchObject({
      type: "targeted",
      queryKeys: [["shell", "session", "ses_1", "requests"]],
    })

    expect(
      classifyStreamEvent(
        event("session.updated", {
          sessionID: "ses_1",
          workspaceId: "ws_1",
        }),
      ),
    ).toMatchObject({
      type: "targeted",
      queryKeys: [["shell", "session", "ses_1", "row"]],
    })

    expect(
      classifyStreamEvent(
        event("vcs.updated", {
          workspaceId: "ws_1",
        }),
      ),
    ).toMatchObject({
      type: "targeted",
      queryKeys: [["shell", "workspace", "ws_1", "vcs"]],
    })
  })

  test("routes every conversation event through the conversation class", () => {
    expect(conversationEventTypes.map((type) => classifyStreamEvent(event(type, { sessionID: "ses_1" })).type)).toEqual(
      conversationEventTypes.map(() => "conversation"),
    )
  })

  test("projects targeted request and todo writes through the one router path", () => {
    const schedules: RoutableEvent[] = []
    const marks: string[] = []
    const sinks = routerSinks({ schedules, marks })
    const permission = {
      id: "perm_1",
      sessionID: "ses_query",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    } as PermissionRequest
    const todos = [{ id: "todo_1", content: "Ship it", status: "pending" }] as Todo[]

    routeDirectoryEvent({ event: { type: "permission.asked", properties: permission }, directory: "/tmp/ws", sinks })
    routeDirectoryEvent({
      event: { type: "todo.updated", properties: { sessionID: "ses_query", todos } },
      directory: "/tmp/ws",
      sinks,
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "requests"))).toEqual({
      permissions: [permission],
      questions: [],
    })
    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "todo"))).toEqual(todos)
    expect(schedules.map((item) => item.type)).toEqual(["permission.asked", "todo.updated"])
    expect(marks).toEqual(["marked", "marked"])
  })

  test("notifies query subscribers when an SSE event writes session todo data", async () => {
    const sessionID = "ses_query"
    const notifications: Todo[][] = []
    const options = sessionTodoQueryOptions({
      sessionId: sessionID,
      staleTime: Infinity,
      client: {
        session: {
          todo: () => {
            throw new Error("subscriber freshness test should not refetch")
          },
        },
      },
    })
    queryClient.setQueryData(options.queryKey, [])
    const observer = new QueryObserver(queryClient, options)
    const unsubscribe = observer.subscribe((result) => {
      if (result.data) notifications.push(result.data)
    })

    try {
      notifications.length = 0
      const todos = [{ id: "todo_1", content: "Ship it", status: "pending" }] as Todo[]
      routeDirectoryEvent({
        event: { type: "todo.updated", properties: { sessionID, todos } },
        directory: "/tmp/ws",
        sinks: routerSinks(),
      })
      await Promise.resolve()

      expect(notifications).toEqual([todos])
    } finally {
      unsubscribe()
    }
  })

  test("session deletion removes session-scoped queries and directory cache row", () => {
    const sinks = routerSinks({
      cache: {
        at: 1,
        limit: 10,
        total: 1,
        session: [root("ses_query")],
      },
    })
    queryClient.setQueryData(shellDataKeys.sessionId("ses_query", "todo"), [{ id: "todo_1" }])
    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/ws"), sinks.cacheValue())

    routeDirectoryEvent({
      event: { type: "session.deleted", properties: { info: root("ses_query") } },
      directory: "/tmp/ws",
      sinks,
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_query", "todo"))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.directory.sessionCache("/tmp/ws"))).toMatchObject({
      total: 0,
      session: [],
    })
    expect(sinks.cacheValue()).toMatchObject({
      total: 0,
      session: [],
    })
  })

  test("projects generated titles into the live sidebar session-list cache", () => {
    const key = queryKeys.shell.sessionList(undefined, {
      scope: "workspace",
      directory: "/tmp/ws",
      limit: 10,
    })
    queryClient.setQueryData(key, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 10 },
      items: [
        {
          type: "session",
          sessionRef: "local:/tmp/ws:session:ses_title",
          sessionId: "ses_title",
          title: "Untitled session",
          directory: "/tmp/ws",
          createdAt: 1,
          updatedAt: 1,
          tags: [],
          attachments: [],
        },
      ],
      totalKnown: 1,
    })

    routeDirectoryEvent({
      event: {
        type: "session.updated",
        properties: {
          info: {
            id: "ses_title",
            title: "Fix live Codex titles",
            directory: "/tmp/ws",
            time: { created: 1, updated: 2 },
          },
        },
      },
      directory: "/tmp/ws",
      sinks: routerSinks(),
    })

    expect(queryClient.getQueryData<{ items: Array<{ title: string }> }>(key)?.items[0]?.title).toBe(
      "Fix live Codex titles",
    )
  })
})
