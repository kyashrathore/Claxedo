import { describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionListResponse } from "@/features/session/data/query/session-list"
import { createGlobalSyncEventIngress } from "./event-ingress"
import type { RoutableEvent } from "./event-router"
import type { ClaxedoEvent } from "../claxedo-events"

function eventSource() {
  let handler: ((event: { name: string; details: RoutableEvent }) => void) | undefined
  return {
    source: {
      listen: (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    },
    emit: (event: { name: string; details: RoutableEvent }) => handler?.(event),
  }
}

function claxedoEventSource() {
  const handlers = new Map<string, Set<(event: ClaxedoEvent) => void>>()
  return {
    source: {
      on: (type, handler) => {
        const set = handlers.get(type) ?? new Set()
        set.add(handler as (event: ClaxedoEvent) => void)
        handlers.set(type, set)
        return () => {
          set.delete(handler as (event: ClaxedoEvent) => void)
        }
      },
    },
    emit: (event: ClaxedoEvent) => {
      handlers.get(event.type)?.forEach((handler) => handler(event))
    },
  }
}

describe("global sync event ingress", () => {
  test("maps a signed runtime project id to the inventory project before inserting a created rail row", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const key = queryKeys.shell.sessionList("http://test.local", {
      scope: "project",
      projectId: "proj_control",
      limit: 5,
    })
    queryClient.setQueryData<SessionListResponse>(key, {
      view: { scope: "project", groupBy: "none", sort: "updated_desc", limit: 5 },
      items: [],
      totalKnown: 0,
    })
    const dispose = createGlobalSyncEventIngress({
      globalEvents: globalEvents.source,
      claxedoEvents: claxedoEvents.source,
      projects: () => [],
      projectFor: () => ({
        id: "proj_control",
        worktree: "/repo",
        sandboxes: ["/repo"],
        time: { created: 1, updated: 1 },
      }),
      children: {
        directories: () => ["/repo"],
        has: () => true,
        mark: () => undefined,
        sessionCache: () => ({ session: [], total: 0, limit: 5, at: 0 }),
      },
      push: () => undefined,
      refresh: () => undefined,
      setGlobalProject: () => undefined,
      sessionInventoryLoaded: () => false,
      applySessionEvent: () => undefined,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    claxedoEvents.emit({
      type: "session.lifecycle",
      phase: "created",
      directory: "/repo",
      workspaceId: "ws_1",
      sessionID: "ses_new",
      info: {
        id: "ses_new",
        slug: "ses-new",
        projectID: "runtime_git_project_hash",
        workspaceID: "ws_1",
        directory: "/repo",
        title: "New session",
        version: "1",
        time: { created: 10, updated: 10 },
      },
      ts: 10,
    })

    expect(queryClient.getQueryData<SessionListResponse>(key)?.items?.[0]).toMatchObject({
      sessionId: "ses_new",
      projectId: "proj_control",
      workspaceId: "ws_1",
    })
    dispose()
  })

  test("invalidates the paginated session list for a plain session.created event", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const key = ["shell", "default", "sessionList", { directory: "/repo" }] as const
    queryClient.setQueryData(key, { session: [], total: 0 })
    const dispose = createGlobalSyncEventIngress({
      globalEvents: globalEvents.source,
      claxedoEvents: undefined,
      projects: () => [],
      projectFor: () => undefined,
      children: {
        directories: () => [],
        has: () => false,
        mark: () => undefined,
        sessionCache: () => ({ session: [], total: 0, limit: 0, at: 0 }),
      },
      push: () => undefined,
      refresh: () => undefined,
      setGlobalProject: () => undefined,
      sessionInventoryLoaded: () => false,
      applySessionEvent: () => undefined,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    globalEvents.emit({
      name: "/repo",
      details: { type: "session.created", properties: { info: { id: "ses_created" } } },
    })

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    dispose()
  })

  test("projects targeted session todo events even when the directory is not a registered child", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const dispose = createGlobalSyncEventIngress({
      globalEvents: globalEvents.source,
      claxedoEvents: undefined,
      projects: () => [],
      projectFor: () => undefined,
      children: {
        directories: () => [],
        has: () => false,
        mark: () => undefined,
        sessionCache: () => ({ session: [], total: 0, limit: 0, at: 0 }),
      },
      push: () => undefined,
      refresh: () => undefined,
      setGlobalProject: () => undefined,
      sessionInventoryLoaded: () => false,
      applySessionEvent: () => undefined,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    globalEvents.emit({
      name: "/repo",
      details: {
        type: "todo.updated",
        properties: {
          sessionID: "ses_todo",
          todos: [{ id: "todo_1", content: "Wire", status: "pending" }],
        },
      },
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_todo", "todo"))).toEqual([
      { id: "todo_1", content: "Wire", status: "pending" },
    ])
    dispose()
  })

  test("projects claxedo stream todo envelopes into shell queries", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const dispose = createGlobalSyncEventIngress({
      globalEvents: globalEvents.source,
      claxedoEvents: claxedoEvents.source,
      projects: () => [],
      projectFor: () => undefined,
      children: {
        directories: () => [],
        has: () => false,
        mark: () => undefined,
        sessionCache: () => ({ session: [], total: 0, limit: 0, at: 0 }),
      },
      push: () => undefined,
      refresh: () => undefined,
      setGlobalProject: () => undefined,
      sessionInventoryLoaded: () => false,
      applySessionEvent: () => undefined,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    claxedoEvents.emit({
      type: "todo.updated",
      directory: "/repo",
      properties: {
        sessionID: "ses_claxedo_todo",
        todos: [{ id: "todo_1", content: "Wire", status: "pending" }],
      },
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_claxedo_todo", "todo"))).toEqual([
      { id: "todo_1", content: "Wire", status: "pending" },
    ])
    dispose()
  })
})
