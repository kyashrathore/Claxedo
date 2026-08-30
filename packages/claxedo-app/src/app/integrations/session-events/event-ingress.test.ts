import { describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionListResponse } from "@/features/session/data/query/session-list"
import {
  readSessionInventoryQueryData,
  setSessionInventoryQueryData,
} from "@/features/session/data/sync/inventory-writers"
import type { SessionInventoryRow } from "@/features/session/data/query/types"
import { emptySessionInventory } from "@/features/session/data/sync/queries"
import { createGlobalSyncEventIngress } from "./event-ingress"
import type { RoutableEvent } from "./event-router"
import type { ClaxedoEvent } from "../claxedo-events"
import type { SessionTitleProjectionApi } from "@/features/session/store/session-title-projection"

const noopSessionTitles: Pick<SessionTitleProjectionApi, "publishCanonical" | "remove"> = {
  publishCanonical: () => undefined,
  remove: () => undefined,
}

function titleWriter() {
  const canonical: Array<Parameters<SessionTitleProjectionApi["publishCanonical"]>[0]> = []
  const removed: Array<Parameters<SessionTitleProjectionApi["remove"]>[0]> = []
  return {
    canonical,
    removed,
    writer: {
      publishCanonical: (target) => canonical.push(target),
      remove: (target) => removed.push(target),
    } satisfies Pick<SessionTitleProjectionApi, "publishCanonical" | "remove">,
  }
}

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
    const sessionTitles = titleWriter()
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
      sessionTitles: sessionTitles.writer,
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
    expect(sessionTitles.canonical).toEqual([{
      sessionId: "ses_new",
      directory: "/repo",
      workspaceId: "ws_1",
      title: "New session",
      updatedAt: 10,
    }])
    dispose()
  })

  test("projects canonical title events before the session inventory has loaded", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const sessionTitles = titleWriter()
    const inventoryEvents: string[] = []
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
      applySessionEvent: (_info, type) => inventoryEvents.push(type),
      sessionTitles: sessionTitles.writer,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    globalEvents.emit({
      name: "/repo",
      details: {
        type: "session.created",
        properties: {
          info: {
            id: "ses_title",
            directory: "/repo",
            workspaceID: "ws_1",
            title: "Provisional canonical",
            time: { created: 10, updated: 10 },
          },
        },
      },
    })
    globalEvents.emit({
      name: "/repo",
      details: {
        type: "session.updated",
        properties: {
          info: {
            id: "ses_title",
            directory: "/repo",
            workspaceID: "ws_1",
            title: "Canonical title",
            time: { created: 10, updated: 20 },
          },
        },
      },
    })
    globalEvents.emit({
      name: "/repo",
      details: {
        type: "session.deleted",
        properties: {
          info: {
            id: "ses_title",
            directory: "/repo",
            workspaceID: "ws_1",
          },
        },
      },
    })

    expect(inventoryEvents).toEqual([])
    expect(sessionTitles.canonical).toEqual([
      {
        sessionId: "ses_title",
        directory: "/repo",
        workspaceId: "ws_1",
        title: "Provisional canonical",
        updatedAt: 10,
      },
      {
        sessionId: "ses_title",
        directory: "/repo",
        workspaceId: "ws_1",
        title: "Canonical title",
        updatedAt: 20,
      },
    ])
    expect(sessionTitles.removed).toEqual([{
      sessionId: "ses_title",
      directory: "/repo",
      workspaceId: "ws_1",
    }])
    dispose()
  })

  test("projects claxedo session.updated titles through the same narrow writer", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const sessionTitles = titleWriter()
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
      sessionTitles: sessionTitles.writer,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    claxedoEvents.emit({
      type: "session.updated",
      directory: "/repo",
      properties: {
        info: {
          id: "ses_stream",
          directory: "/repo",
          title: "Streamed title",
          time: { created: 30, updated: 40 },
        },
      },
    })

    expect(sessionTitles.canonical).toEqual([{
      sessionId: "ses_stream",
      directory: "/repo",
      title: "Streamed title",
      updatedAt: 40,
    }])

    // The bridged auto-title frame stamps `workspaceId` on the FRAME, not on
    // `info` — it must reach the writer so the canonical also lands under the
    // workspace key that workspace-attributed rail rows resolve first.
    claxedoEvents.emit({
      type: "session.updated",
      directory: "/repo",
      workspaceId: "ws_stream",
      properties: {
        info: {
          id: "ses_stream",
          directory: "/repo",
          title: "Retitled on the workspace stream",
          time: { created: 30, updated: 50 },
        },
      },
    })
    expect(sessionTitles.canonical[1]).toEqual({
      sessionId: "ses_stream",
      directory: "/repo",
      workspaceId: "ws_stream",
      title: "Retitled on the workspace stream",
      updatedAt: 50,
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
      sessionTitles: noopSessionTitles,
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
      sessionTitles: noopSessionTitles,
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
      sessionTitles: noopSessionTitles,
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

  test("share grant invalidates without eviction while revoke evicts before refetch", async () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const listKey = queryKeys.shell.sessionList("http://test.local", {
      scope: "project",
      projectId: "proj_1",
      limit: 5,
    })
    const inventoryKey = queryKeys.shell.sessionInventory("http://test.local")
    queryClient.setQueryData<SessionListResponse>(listKey, {
      view: { scope: "project", groupBy: "none", sort: "updated_desc", limit: 5 },
      items: [{
        type: "session",
        sessionRef: "workspace:ws_1:session:ses_shared",
        sessionId: "ses_shared",
        title: "Shared",
        directory: "/repo",
        workspaceId: "ws_1",
        projectId: "proj_1",
        createdAt: 1,
        updatedAt: 1,
        tags: [],
        attachments: [],
      }],
      totalKnown: 1,
    })
    const inventoryRow: SessionInventoryRow = {
      id: "ses_shared",
      title: "Shared",
      directory: "/repo",
      workspaceId: "ws_1",
      projectID: "proj_1",
      tags: [],
      attachments: [],
      time: { created: 1, updated: 1 },
    }
    setSessionInventoryQueryData({
      baseUrl: "http://test.local",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [inventoryRow],
        loaded: true,
      },
    })
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
      sessionTitles: noopSessionTitles,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    claxedoEvents.emit({
      type: "session.share.changed",
      phase: "granted",
      ownerUserId: "user_bob",
      sessionId: "ses_shared",
      workspaceId: "ws_1",
      ts: 1,
    })

    await Promise.resolve()
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(inventoryKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryData<SessionListResponse>(listKey)?.items?.map((row) => row.sessionId)).toEqual([
      "ses_shared",
    ])
    expect(readSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test.local",
    }).sessions.map((row) => row.id)).toEqual(["ses_shared"])

    claxedoEvents.emit({
      type: "session.share.changed",
      phase: "revoked",
      ownerUserId: "user_bob",
      sessionId: "ses_shared",
      workspaceId: "ws_1",
      ts: 2,
    })

    expect(queryClient.getQueryData<SessionListResponse>(listKey)?.items).toEqual([])
    expect(readSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test.local",
    }).sessions).toEqual([])
    dispose()
  })
})
