import { afterEach, describe, expect, test } from "bun:test"
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
import {
  createGlobalSyncEventIngress,
  createSessionAuthorityRevision,
  reconcileAuthorizedSessionPersistence,
} from "./event-ingress"
import type { RoutableEvent } from "./event-router"
import type { ClaxedoEvent } from "../claxedo-events"
import type { SessionTitleProjectionApi } from "@/features/session/store/session-title-projection"
import {
  clearConversationChatRegistryForTest,
  conversationEntryIdsForTest,
  hydrateRegisteredConversationSnapshot,
} from "@/features/session/conversation/conversation-registry"
import { conversationSnapshotKey } from "@/features/session/conversation/conversation-chat-client"
import {
  flushQueryPersistence,
  installQueryPersister,
  queryPersisterKey,
  resetQueryPersisterForTest,
} from "@/platform/query/persister"
import {
  conversationPersistence,
  conversationPersistenceKey,
  preparePersistedSessionRevocation,
  setConversationPersistencePrincipal,
  setConversationPersistenceStorageForTest,
} from "@/features/session/conversation/conversation-persistence"

const noopSessionTitles: Pick<SessionTitleProjectionApi, "publishCanonical" | "remove"> = {
  publishCanonical: () => undefined,
  remove: () => undefined,
}

const revocationDefaults = {
  sessionAccessRetained: async () => false,
  revocationScope: () => "signed:user_bob",
  flushNavigationPersistence: async () => undefined,
}

afterEach(() => {
  resetQueryPersisterForTest()
  setConversationPersistencePrincipal(undefined)
  setConversationPersistenceStorageForTest(undefined)
})

test("authority changes invalidate already-issued inventory responses", async () => {
  const authority = createSessionAuthorityRevision()
  const responseIsCurrent = authority.capture(() => true)
  let complete: (() => void) | undefined
  const response = new Promise<void>((resolve) => {
    complete = resolve
  })

  authority.invalidate()
  complete?.()
  await response

  expect(responseIsCurrent()).toBe(false)
  expect(authority.capture(() => true)()).toBe(true)
})

test("canonical inventory reopens durable conversation writes after a missed regrant doorbell", async () => {
  const values = new Map<IDBValidKey, unknown>()
  setConversationPersistenceStorageForTest({
    get: async (key) => values.get(key) as never,
    set: async (key, value) => { values.set(key, value) },
    delete: async (key) => { values.delete(key) },
    keys: async () => [...values.keys()],
  })
  setConversationPersistencePrincipal("signed:user_bob")
  const key = conversationPersistenceKey("/repo\0ses_shared")
  const revoke = preparePersistedSessionRevocation("ses_shared", "signed:user_bob")
  await revoke.purge()

  await Promise.resolve(conversationPersistence.setItem(key, []))
  expect(values.has(key)).toBe(false)

  reconcileAuthorizedSessionPersistence([{ id: "ses_shared" }], "signed:user_bob")
  await Promise.resolve(conversationPersistence.setItem(key, []))
  expect(values.has(key)).toBe(true)
})

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

/**
 * The frames a workspace served by ANOTHER machine publishes, and the catalog
 * that classifies it.
 *
 * `workspace-runtime`'s `sessionLifecycleInfo` fills `info.directory` from the
 * store row / `assertTarget` result, and `assertTarget` has already translated
 * the app's `workspace:<id>` request header into the pinned host path, so no
 * producer ever puts a workspace address back on the wire — `info.directory` is
 * the producing machine's own path, always.
 */
const HOST_DIR = "/Users/host/repo"
/** A live user-hosted workspace id: caller-chosen, never a minted `ws_*`. */
const USER_HOSTED_UUID = "5f39af3e-75c4-4392-baaf-574acbbf9db9"
/** The same shape, but only ever this machine's own local association. */
const LOCAL_ASSOCIATION_UUID = "9c1d2f80-4b6a-4d1e-9f27-1a3b5c7d9e11"

function hostProject(workspace: { id: string; kind: string }) {
  return {
    id: "proj_host",
    worktree: HOST_DIR,
    sandboxes: [HOST_DIR],
    time: { created: 1, updated: 1 },
    workspaces: { [workspace.id]: { id: workspace.id, kind: workspace.kind, directory: HOST_DIR } },
  }
}

function createdFrame(sessionId: string, workspaceId: string) {
  return {
    type: "session.created",
    properties: {
      info: {
        id: sessionId,
        title: "created on the host",
        directory: HOST_DIR,
        workspaceID: workspaceId,
        time: { created: 10, updated: 20 },
      },
    },
  } satisfies RoutableEvent
}

function lifecycleFrame(sessionId: string, workspaceId: string) {
  return {
    type: "session.lifecycle",
    phase: "created",
    directory: HOST_DIR,
    workspaceId,
    sessionID: sessionId,
    info: {
      id: sessionId,
      slug: sessionId.replace(/_/g, "-"),
      projectID: "runtime_git_project_hash",
      workspaceID: workspaceId,
      directory: HOST_DIR,
      title: "created on the host",
      version: "1",
      time: { created: 30, updated: 40 },
    },
    ts: 40,
  } satisfies ClaxedoEvent
}

function hostIngressInput(overrides: {
  globalEvents: Parameters<typeof createGlobalSyncEventIngress>[0]["globalEvents"]
  claxedoEvents: Parameters<typeof createGlobalSyncEventIngress>[0]["claxedoEvents"]
  projects: Parameters<typeof createGlobalSyncEventIngress>[0]["projects"]
}) {
  return {
    ...revocationDefaults,
    ...overrides,
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
    sessionCacheLimit: (_directory: string, fallback: number) => fallback,
  } satisfies Parameters<typeof createGlobalSyncEventIngress>[0]
}

describe("global sync event ingress", () => {
  test("keeps central runtime session-info updates out of workspace inventory", () => {
    const globalEvents = eventSource()
    const applied: unknown[] = []
    const sessionTitles = titleWriter()
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
      sessionInventoryLoaded: () => true,
      applySessionEvent: (info, type) => applied.push({ info, type }),
      sessionTitles: sessionTitles.writer,
      draftWasRolledBack: () => false,
      cacheSessions: () => undefined,
      sessionCacheLimit: (_directory, fallback) => fallback,
    })

    globalEvents.emit({
      name: "session-1",
      details: {
        type: "session.updated",
        properties: {
          info: {
            id: "session-1",
            slug: "session-1",
            projectID: "session-1",
            directory: "session-1",
            title: "Pi session",
            version: "local",
            time: { created: 1, updated: 2 },
            sessionRef: "central:session-1",
            host: "central",
            workspaceID: "workspace-1",
          },
        },
      },
    })

    expect(applied).toEqual([])
    expect(sessionTitles.canonical).toEqual([{
      sessionId: "session-1",
      directory: "session-1",
      workspaceId: "workspace-1",
      title: "Pi session",
      updatedAt: 2,
    }])
    dispose()
  })

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
      ...revocationDefaults,
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
      ...revocationDefaults,
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
      ...revocationDefaults,
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

  /**
   * The workspace's own stream is the authority for its list, so a created
   * frame is APPLIED, not used as a doorbell: the row appears with no list
   * request at all, and the cached entry is never invalidated.
   */
  test("adds a session.created row to the paginated list without invalidating it", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const query = {
      scope: "workspace",
      directory: "/repo",
      groupBy: "none",
      archived: "active",
      status: [],
      environment: [],
      git: [],
      sort: "updated_desc",
      limit: 20,
    }
    const key = ["shell", "default", "sessionList", query] as const
    queryClient.setQueryData(key, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 20 },
      items: [],
      totalKnown: 0,
    })
    const dispose = createGlobalSyncEventIngress({
      ...revocationDefaults,
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
        type: "session.created",
        properties: {
          info: {
            id: "ses_created",
            title: "created on the host",
            directory: "/repo",
            time: { created: 10, updated: 20 },
          },
        },
      },
    })

    expect(
      queryClient.getQueryData<{ items: Array<{ sessionId: string; title: string }> }>(key)?.items,
    ).toEqual([expect.objectContaining({ sessionId: "ses_created", title: "created on the host" })])
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
    dispose()
  })

  /**
   * A minted `ws_*` id is self-identifying, so it addresses the row by
   * workspace with no catalog at all. The row is read back THROUGH its
   * directory (messages, config, agents, transcript), so it must carry the
   * workspace address rather than the producing host's path.
   */
  test("a minted ws_ id addresses the row by workspace with no catalog loaded", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const key = queryKeys.shell.sessionList("http://test.local", {
      scope: "workspace",
      workspaceId: "ws_1",
      directory: "workspace:ws_1",
      groupBy: "none",
      archived: "active",
      status: [],
      environment: [],
      git: [],
      sort: "updated_desc",
      limit: 20,
    })
    queryClient.setQueryData<SessionListResponse>(key, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 20 },
      items: [],
      totalKnown: 0,
    })
    const dispose = createGlobalSyncEventIngress(
      hostIngressInput({
        globalEvents: globalEvents.source,
        claxedoEvents: claxedoEvents.source,
        projects: () => [],
      }),
    )

    globalEvents.emit({ name: HOST_DIR, details: createdFrame("ses_stream", "ws_1") })
    claxedoEvents.emit(lifecycleFrame("ses_lifecycle", "ws_1"))

    const items = queryClient.getQueryData<SessionListResponse>(key)?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_lifecycle", "ses_stream"])
    expect(items?.map((item) => item.directory)).toEqual(["workspace:ws_1", "workspace:ws_1"])
    dispose()
  })

  /**
   * A shared machine publishes the workspace under the id it ALREADY held — a
   * `randomUUID()` from its own workspace store — and the control plane keeps
   * that id verbatim, so a live user-hosted host's frames name a uuid, never a
   * minted `ws_*` id. The catalog knowing that uuid as `user-hosted` is what
   * makes the row workspace-addressed.
   */
  test("a uuid the catalog knows as user-hosted addresses the row by workspace", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const key = queryKeys.shell.sessionList("http://test.local", {
      scope: "workspace",
      workspaceId: USER_HOSTED_UUID,
      directory: `workspace:${USER_HOSTED_UUID}`,
      groupBy: "none",
      archived: "active",
      status: [],
      environment: [],
      git: [],
      sort: "updated_desc",
      limit: 20,
    })
    queryClient.setQueryData<SessionListResponse>(key, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 20 },
      items: [],
      totalKnown: 0,
    })
    const dispose = createGlobalSyncEventIngress(
      hostIngressInput({
        globalEvents: globalEvents.source,
        claxedoEvents: claxedoEvents.source,
        projects: () => [hostProject({ id: USER_HOSTED_UUID, kind: "user-hosted" })],
      }),
    )

    globalEvents.emit({ name: HOST_DIR, details: createdFrame("ses_stream", USER_HOSTED_UUID) })
    claxedoEvents.emit(lifecycleFrame("ses_lifecycle", USER_HOSTED_UUID))

    const items = queryClient.getQueryData<SessionListResponse>(key)?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_lifecycle", "ses_stream"])
    expect(items?.map((item) => item.directory))
      .toEqual([`workspace:${USER_HOSTED_UUID}`, `workspace:${USER_HOSTED_UUID}`])
    expect(items?.map((item) => item.sessionRef)).toEqual([
      `workspace:${USER_HOSTED_UUID}:session:ses_lifecycle`,
      `workspace:${USER_HOSTED_UUID}:session:ses_stream`,
    ])
    dispose()
  })

  /**
   * The same uuid shape, but the catalog knows it only as this machine's LOCAL
   * association. Addressing it by workspace would mint a `workspace:<uuid>` row
   * beside the `local:<dir>` row for one session (issue #14), so the row stays
   * local: the host path IS an address this app can read.
   */
  test("a uuid the catalog knows only as a local association keeps the local row", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const key = queryKeys.shell.sessionList("http://test.local", {
      scope: "workspace",
      directory: HOST_DIR,
      groupBy: "none",
      archived: "active",
      status: [],
      environment: [],
      git: [],
      sort: "updated_desc",
      limit: 20,
    })
    queryClient.setQueryData<SessionListResponse>(key, {
      view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 20 },
      items: [],
      totalKnown: 0,
    })
    const dispose = createGlobalSyncEventIngress(
      hostIngressInput({
        globalEvents: globalEvents.source,
        claxedoEvents: claxedoEvents.source,
        projects: () => [hostProject({ id: LOCAL_ASSOCIATION_UUID, kind: "local" })],
      }),
    )

    globalEvents.emit({ name: HOST_DIR, details: createdFrame("ses_stream", LOCAL_ASSOCIATION_UUID) })
    claxedoEvents.emit(lifecycleFrame("ses_lifecycle", LOCAL_ASSOCIATION_UUID))

    const items = queryClient.getQueryData<SessionListResponse>(key)?.items
    expect(items?.map((item) => item.sessionId)).toEqual(["ses_lifecycle", "ses_stream"])
    expect(items?.map((item) => item.directory)).toEqual([HOST_DIR, HOST_DIR])
    expect(items?.map((item) => item.sessionRef)).toEqual([
      `local:${HOST_DIR}:session:ses_lifecycle`,
      `local:${HOST_DIR}:session:ses_stream`,
    ])
    expect(items?.some((item) => item.workspaceId)).toBe(false)
    dispose()
  })

  test("projects targeted session todo events even when the directory is not a registered child", () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const dispose = createGlobalSyncEventIngress({
      ...revocationDefaults,
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
      ...revocationDefaults,
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

  test("share revoke preserves retained access, then durably evicts confirmed loss with retry", async () => {
    queryClient.clear()
    const persisted = new Map<string, string>()
    await installQueryPersister({
      storage: {
        getItem: (key) => persisted.get(key) ?? null,
        setItem: (key, value) => persisted.set(key, value),
        removeItem: (key) => persisted.delete(key),
      },
      buster: "event-ingress-test",
      throttleTime: 60_000,
    })?.restore
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
    hydrateRegisteredConversationSnapshot({
      directory: "/repo",
      sessionID: "ses_shared",
      messages: [],
      parts: {},
    })
    await flushQueryPersistence()
    expect(persisted.get(queryPersisterKey)).toContain("ses_shared")
    hydrateRegisteredConversationSnapshot({
      directory: "/repo-alias",
      sessionID: "ses_shared",
      messages: [],
      parts: {},
    })
    hydrateRegisteredConversationSnapshot({
      directory: "/repo",
      sessionID: "ses_keep",
      messages: [],
      parts: {},
    })
    const revoked: Array<{ sessionId: string; workspaceId: string }> = []
    let retainsAccess = true
    let accessFailures = 3
    let accessAttempts = 0
    let flushAttempts = 0
    const dispose = createGlobalSyncEventIngress({
      ...revocationDefaults,
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
      sessionAccessRetained: async () => {
        accessAttempts++
        if (!retainsAccess && accessFailures-- > 0) throw new Error("transient authority failure")
        return retainsAccess
      },
      onSessionAccessRevoked: (event) => revoked.push(event),
      flushNavigationPersistence: async () => {
        flushAttempts++
        if (flushAttempts <= 4) throw new Error("transient IndexedDB failure")
        await flushQueryPersistence()
      },
      revocationRetryDelays: [0],
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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queryClient.getQueryData<SessionListResponse>(listKey)?.items?.map((row) => row.sessionId)).toEqual([
      "ses_shared",
    ])
    expect(readSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test.local",
    }).sessions.map((row) => row.id)).toEqual(["ses_shared"])
    expect(conversationEntryIdsForTest().sort()).toEqual([
      "/repo\0ses_keep",
      "/repo\0ses_shared",
      "/repo-alias\0ses_shared",
    ])
    expect(revoked).toEqual([])

    retainsAccess = false
    claxedoEvents.emit({
      type: "session.share.changed",
      phase: "revoked",
      ownerUserId: "user_bob",
      sessionId: "ses_shared",
      workspaceId: "ws_1",
      ts: 3,
    })

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    for (let attempt = 0; attempt < 50 && revoked.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(queryClient.getQueryData<SessionListResponse>(listKey)?.items).toEqual([])
    expect(readSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test.local",
    }).sessions).toEqual([])
    expect(queryClient.getQueryData(conversationSnapshotKey({ directory: "/repo", sessionID: "ses_shared" }))).toBeUndefined()
    expect(queryClient.getQueryData(conversationSnapshotKey({ directory: "/repo-alias", sessionID: "ses_shared" }))).toBeUndefined()
    expect(conversationEntryIdsForTest()).toEqual(["/repo\0ses_keep"])
    expect(revoked).toEqual([{ sessionId: "ses_shared", workspaceId: "ws_1" }])
    expect(accessAttempts).toBe(8)
    expect(flushAttempts).toBe(6)
    expect(persisted.get(queryPersisterKey)).not.toContain("ses_shared")
    dispose()
    clearConversationChatRegistryForTest()
  })

  test("a newer grant cancels a revoke waiting for durable cleanup", async () => {
    queryClient.clear()
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const revoked: Array<{ sessionId: string; workspaceId: string }> = []
    let rejectFlush: ((error: Error) => void) | undefined
    let flushStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      flushStarted = resolve
    })
    const blockedFlush = new Promise<void>((_resolve, reject) => {
      rejectFlush = reject
    })
    let flushAttempts = 0
    const dispose = createGlobalSyncEventIngress({
      ...revocationDefaults,
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
      onSessionAccessRevoked: (event) => revoked.push(event),
      flushNavigationPersistence: async () => {
        flushAttempts++
        if (flushAttempts === 1) {
          flushStarted?.()
          await blockedFlush
        }
      },
      revocationRetryDelays: [0],
    })

    const changed = {
      type: "session.share.changed" as const,
      ownerUserId: "user_bob",
      sessionId: "ses_shared",
      workspaceId: "ws_1",
      ts: 1,
    }
    claxedoEvents.emit({ ...changed, phase: "revoked" })
    await started
    claxedoEvents.emit({ ...changed, phase: "granted", ts: 2 })
    rejectFlush?.(new Error("transient IndexedDB failure"))
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(flushAttempts).toBe(1)
    expect(revoked).toEqual([])
    dispose()
  })

  test("an authority recheck catches a regrant whose doorbell was missed", async () => {
    queryClient.clear()
    clearConversationChatRegistryForTest()
    hydrateRegisteredConversationSnapshot({
      directory: "/repo",
      sessionID: "ses_shared",
      messages: [],
      parts: {},
    })
    const globalEvents = eventSource()
    const claxedoEvents = claxedoEventSource()
    const revoked: Array<{ sessionId: string; workspaceId: string }> = []
    let retainsAccess = false
    let accessAttempts = 0
    let flushAttempts = 0
    let rejectFirstFlush: ((error: Error) => void) | undefined
    let markFlushStarted: (() => void) | undefined
    const flushStarted = new Promise<void>((resolve) => {
      markFlushStarted = resolve
    })
    const firstFlush = new Promise<void>((_resolve, reject) => {
      rejectFirstFlush = reject
    })
    const dispose = createGlobalSyncEventIngress({
      ...revocationDefaults,
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
      sessionAccessRetained: async () => {
        accessAttempts++
        return retainsAccess
      },
      onSessionAccessRevoked: (event) => revoked.push(event),
      flushNavigationPersistence: async () => {
        flushAttempts++
        if (flushAttempts === 1) {
          markFlushStarted?.()
          await firstFlush
        }
      },
      revocationRetryDelays: [0],
    })

    claxedoEvents.emit({
      type: "session.share.changed",
      phase: "revoked",
      ownerUserId: "user_bob",
      sessionId: "ses_shared",
      workspaceId: "ws_1",
      ts: 1,
    })
    await flushStarted
    retainsAccess = true
    rejectFirstFlush?.(new Error("transient IndexedDB failure"))
    for (let attempt = 0; attempt < 20 && accessAttempts < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(flushAttempts).toBe(2)
    expect(accessAttempts).toBe(2)
    expect(revoked).toEqual([])
    expect(conversationEntryIdsForTest()).toEqual(["/repo\0ses_shared"])
    dispose()
    clearConversationChatRegistryForTest()
  })
})
