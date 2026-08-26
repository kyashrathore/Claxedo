import { afterEach, describe, expect, test } from "bun:test"
import { QueryObserver } from "@tanstack/solid-query"
import { queryClient } from "@/platform/query/query-client"
import {
  applySessionInventoryLifecycle,
  createSessionInventorySnapshotValue,
  mergeSessionInventoryProjectPage,
  mergeSessionInventoryWorkspaceGroups,
  mergeSessionInventoryWorkspacePage,
  readSessionInventoryQueryData,
  removeSessionInventoryQueryData,
  replaceSessionInventoryWorkspaceGroups,
  replaceSessionInventoryWorkspaceRows,
  setSessionInventoryQueryData,
  updateSessionInventoryQueryData,
  upsertSessionInventoryRow,
} from "./inventory-writers"
import { emptySessionInventory, sessionInventoryQueryOptions } from "./queries"
import type { SessionInventoryRow } from "../query/types"

afterEach(() => {
  queryClient.clear()
})

describe("session inventory writers", () => {
  test("stores normalized inventory through the one writer", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [session("ses_old", 1), session("ses_new", 3), session("ses_mid", 2)],
        loaded: true,
      },
    })

    expect(readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" }).sessionOrder).toEqual([
      "ses_new",
      "ses_mid",
      "ses_old",
    ])
    expect(queryClient.getQueryData(sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: "http://test" }).queryKey)).toEqual({
      sessions: [
        session("ses_new", 3),
        session("ses_mid", 2),
        session("ses_old", 1),
      ],
      globalState: { hasMore: false, loading: false },
      projectState: {},
      workspaceMeta: {},
      workspaceState: {},
      workspaceOrder: [],
      loading: false,
      loaded: true,
      initialCursor: undefined,
    })
  })

  test("upsert of a newer row wins over stale rows and updates derived indexes once", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [session("ses_1", 1, { title: "Old" })],
        loaded: true,
      },
    })

    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        upsertSessionInventoryRow(draft, session("ses_1", 5, { title: "New" }))
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions).toMatchObject([{ id: "ses_1", title: "New" }])
    expect(inventory.byProject.project_a).toMatchObject([{ id: "ses_1", title: "New" }])
    expect(inventory.byWorkspace["/repo/a"].sessions).toMatchObject([{ id: "ses_1", title: "New" }])
  })

  test("workspace metadata preserves non-derivable paging fields after row upsert", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [session("ses_1", 1, { workspaceId: "ws_1", workspaceName: "Workspace" })],
        workspaceMeta: {
          ws_1: {
            key: "ws_1",
            directory: "/repo/a",
            workspaceId: "ws_1",
            workspaceName: "Workspace",
            projectID: "project_a",
            hasMore: true,
            total: 8,
            nextCursor: 42,
          },
        },
        workspaceOrder: ["ws_1"],
        loaded: true,
      },
    })

    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        upsertSessionInventoryRow(draft, session("ses_2", 2, { workspaceId: "ws_1", workspaceName: "Workspace" }))
      },
    })

    const group = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" }).byWorkspace.ws_1
    expect(group.sessions.map((item) => item.id)).toEqual(["ses_2", "ses_1"])
    expect(group.workspaceName).toBe("Workspace")
    expect(group.hasMore).toBe(true)
    expect(group.total).toBe(8)
    expect(group.nextCursor).toBe(42)
  })

  test("keeps same opaque session id in different workspaces as separate rows", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [
          session("ses_shared", 5, { workspaceId: "ws_1", workspaceName: "One" }),
          session("ses_shared", 6, { directory: "/repo/b", projectID: "project_b", workspaceId: "ws_2", workspaceName: "Two" }),
        ],
        loaded: true,
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions.map((item) => `${item.workspaceId}:${item.id}`)).toEqual([
      "ws_2:ses_shared",
      "ws_1:ses_shared",
    ])
    expect(inventory.byWorkspace.ws_1.sessions.map((item) => item.id)).toEqual(["ses_shared"])
    expect(inventory.byWorkspace.ws_2.sessions.map((item) => item.id)).toEqual(["ses_shared"])
  })

  test("remove deletes a session from canonical rows and derived indexes", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [session("ses_1", 2), session("ses_2", 1)],
        loaded: true,
      },
    })

    removeSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      session: { id: "ses_1", directory: "/repo/a", projectID: "project_a" },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions.map((item) => item.id)).toEqual(["ses_2"])
    expect(inventory.byProject.project_a.map((item) => item.id)).toEqual(["ses_2"])
    expect(inventory.byWorkspace["/repo/a"].sessions.map((item) => item.id)).toEqual(["ses_2"])
  })

  test("remove keeps the canonical inventory empty after deleting its final session", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [session("ses_only", 1)],
        loaded: true,
      },
    })

    removeSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      session: { id: "ses_only", directory: "/repo/a", projectID: "project_a" },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions).toEqual([])
    expect(inventory.byProject.project_a ?? []).toEqual([])
    expect(inventory.byWorkspace["/repo/a"]?.sessions ?? []).toEqual([])
  })

  test("remove deletes a session from legacy indexes when canonical rows are not populated yet", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        global: [session("ses_global", 3, { directory: "global", tags: ["global"] })],
        byProject: {
          project_a: [session("ses_1", 2), session("ses_2", 1)],
        },
        byWorkspace: {
          "/repo/a": {
            directory: "/repo/a",
            projectID: "project_a",
            sessions: [session("ses_1", 2), session("ses_2", 1)],
            hasMore: true,
            total: 4,
          },
        },
        workspaceOrder: ["/repo/a"],
        loaded: true,
      },
    })

    removeSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      session: { id: "ses_1", directory: "/repo/a", projectID: "project_a" },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions.map((item) => item.id)).toEqual(["ses_global", "ses_2"])
    expect(inventory.global.map((item) => item.id)).toEqual(["ses_global"])
    expect(inventory.byProject.project_a.map((item) => item.id)).toEqual(["ses_2"])
    expect(inventory.byWorkspace["/repo/a"].sessions.map((item) => item.id)).toEqual(["ses_2"])
    expect(inventory.byWorkspace["/repo/a"].total).toBe(3)
  })

  test("lifecycle upserts root project sessions and ignores child sessions", () => {
    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        applySessionInventoryLifecycle(draft, session("ses_root", 2), "created")
        applySessionInventoryLifecycle(draft, session("ses_child", 3, { parentID: "ses_root" }), "created")
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions.map((item) => item.id)).toEqual(["ses_root"])
    expect(inventory.byProject.project_a.map((item) => item.id)).toEqual(["ses_root"])
    expect(inventory.byWorkspace["/repo/a"].sessions.map((item) => item.id)).toEqual(["ses_root"])
  })

  test("lifecycle title update patches an existing row even when the event carries no projectID", () => {
    // Regression: an ACP harness session's auto-title fallback publishes a
    // `session.updated` event with `projectID: ""` (see
    // packages/agent-sdk-runtime/src/harnesses/acp/title.ts `maybeAutoTitle`).
    // Before this fix, applySessionInventoryLifecycle unconditionally dropped
    // ANY lifecycle event (created or updated) with an unresolved projectID,
    // so a harness session's title update silently never reached the sidebar
    // inventory even though the row already existed there.
    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        applySessionInventoryLifecycle(draft, session("ses_harness", 2), "created")
        applySessionInventoryLifecycle(
          draft,
          session("ses_harness", 3, { title: "fix the flaky retry test", projectID: "" }),
          "updated",
        )
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions.map((item) => item.id)).toEqual(["ses_harness"])
    expect(inventory.sessions[0]?.title).toBe("fix the flaky retry test")
    // The row keeps its originally-known projectID/grouping rather than being
    // dropped from its project group.
    expect(inventory.byProject.project_a.map((item) => item.id)).toEqual(["ses_harness"])
  })

  test("lifecycle drops a created event with no resolvable projectID (nowhere to place a brand-new row)", () => {
    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        applySessionInventoryLifecycle(draft, session("ses_unplaced", 2, { projectID: "" }), "created")
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions).toEqual([])
  })

  test("lifecycle keeps only visible global-tagged sessions", () => {
    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        applySessionInventoryLifecycle(
          draft,
          session("ses_visible", 2, { directory: "global", tags: ["global", "global:default"] }),
          "created",
        )
        applySessionInventoryLifecycle(
          draft,
          session("ses_hidden", 3, { directory: "global", tags: ["global"] }),
          "created",
        )
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions.map((item) => item.id)).toEqual(["ses_visible"])
    expect(inventory.global.map((item) => item.id)).toEqual(["ses_visible"])
  })

  test("lifecycle deletes through the shared inventory remove path", () => {
    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        applySessionInventoryLifecycle(draft, session("ses_root", 2), "created")
        applySessionInventoryLifecycle(draft, session("ses_root", 2), "deleted")
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessions).toEqual([])
    expect(inventory.byProject.project_a ?? []).toEqual([])
    expect(inventory.byWorkspace["/repo/a"]?.sessions ?? []).toEqual([])
  })

  test("workspace group replacement stores canonical rows and replaces stale metadata", () => {
    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        replaceSessionInventoryWorkspaceGroups(draft, {
          groups: {
            "/repo/b": workspaceGroup("/repo/b", [session("ses_b", 4, { directory: "/repo/b", projectID: "project_b" })], {
              projectID: "project_b",
              total: 7,
              hasMore: true,
              nextCursor: 3,
            }),
          },
          workspaceState: {
            "/repo/b": { hasMore: true, loading: false, cursor: 3 },
          },
          workspaceOrder: ["/repo/b"],
        })
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessionOrder).toEqual(["ses_b"])
    expect(inventory.byProject.project_b.map((item) => item.id)).toEqual(["ses_b"])
    expect(inventory.byWorkspace["/repo/b"].total).toBe(7)
    expect(inventory.byWorkspace["/repo/b"].nextCursor).toBe(3)
    expect(queryClient.getQueryData(sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: "http://test" }).queryKey)).toMatchObject({
      sessions: [session("ses_b", 4, { directory: "/repo/b", projectID: "project_b" })],
      workspaceMeta: {
        "/repo/b": {
          directory: "/repo/b",
          projectID: "project_b",
          total: 7,
          hasMore: true,
          nextCursor: 3,
        },
      },
      workspaceOrder: ["/repo/b"],
    })
  })

  test("snapshot builder returns canonical stored rows plus workspace metadata", () => {
    const value = createSessionInventorySnapshotValue({
      rows: [session("ses_global", 8, { directory: "global", tags: ["global", "global:default"] })],
      groups: {
        ws_1: workspaceGroup("repo/a", [
          session("ses_ws", 5, { workspaceId: "ws_1", workspaceName: "Workspace" }),
        ], {
          total: 9,
          hasMore: true,
          nextCursor: 4,
        }),
      },
      workspaceState: {
        ws_1: { hasMore: true, loading: false, cursor: 4 },
      },
      workspaceOrder: ["ws_1"],
      projectState: {
        project_a: { hasMore: true, loading: false, cursor: undefined },
      },
      loaded: true,
      initialCursor: 12,
    })

    expect(value).toEqual({
      sessions: [
        session("ses_global", 8, { directory: "global", tags: ["global", "global:default"] }),
        session("ses_ws", 5, { workspaceId: "ws_1", workspaceName: "Workspace" }),
      ],
      globalState: { hasMore: false, loading: false },
      projectState: {
        project_a: { hasMore: true, loading: false, cursor: undefined },
      },
      workspaceMeta: {
        ws_1: {
          key: "repo/a",
          directory: "repo/a",
          workspaceId: undefined,
          workspaceName: undefined,
          projectID: "project_a",
          hasMore: true,
          total: 9,
          nextCursor: 4,
        },
      },
      workspaceState: {
        ws_1: { hasMore: true, loading: false, cursor: 4 },
      },
      workspaceOrder: ["ws_1"],
      loading: false,
      loaded: true,
      initialCursor: 12,
    })
  })

  test("filtered workspace group reload merges rows without dropping unrelated workspaces", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [
          session("ses_old", 1),
          session("ses_other", 3, { directory: "/repo/b", projectID: "project_b" }),
        ],
        loaded: true,
      },
    })

    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        mergeSessionInventoryWorkspaceGroups(draft, {
          groups: {
            "/repo/a": workspaceGroup("/repo/a", [session("ses_new", 5)], { total: 5, hasMore: true, nextCursor: 2 }),
          },
          workspaceState: {
            "/repo/a": { hasMore: true, loading: false, cursor: 2 },
          },
        })
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.byWorkspace["/repo/a"].sessions.map((item) => item.id)).toEqual(["ses_new", "ses_old"])
    expect(inventory.byWorkspace["/repo/a"].total).toBe(5)
    expect(inventory.byWorkspace["/repo/b"].sessions.map((item) => item.id)).toEqual(["ses_other"])
  })

  test("project page merge upserts matching workspace rows and updates project loading state", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [session("ses_old", 1)],
        workspaceMeta: {
          "/repo/a": {
            key: "/repo/a",
            directory: "/repo/a",
            projectID: "project_a",
            hasMore: false,
            total: 1,
          },
        },
        workspaceOrder: ["/repo/a"],
        loaded: true,
      },
    })

    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        mergeSessionInventoryProjectPage(draft, {
          projectID: "project_a",
          workspaceKey: "/repo/a",
          directory: "/repo/a",
          rows: [
            session("ses_new", 6),
            session("ses_wrong_dir", 7, { directory: "/repo/c", projectID: "project_a" }),
          ],
          cursor: "4",
        })
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.byProject.project_a.map((item) => item.id)).toEqual(["ses_new", "ses_old"])
    expect(inventory.byWorkspace["/repo/a"].sessions.map((item) => item.id)).toEqual(["ses_new", "ses_old"])
    expect(inventory.byWorkspace["/repo/a"].hasMore).toBe(true)
    expect(inventory.workspaceState["/repo/a"]).toEqual({ hasMore: true, loading: false, cursor: 4 })
    expect(inventory.projectState.project_a).toEqual({ hasMore: false, loading: false, cursor: undefined })
  })

  test("workspace page merge preserves total and computes fallback cursor", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [session("ses_old", 5)],
        workspaceMeta: {
          "/repo/a": {
            key: "/repo/a",
            directory: "/repo/a",
            projectID: "project_a",
            hasMore: true,
            total: 3,
            nextCursor: 5,
          },
        },
        workspaceOrder: ["/repo/a"],
        loaded: true,
      },
    })

    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        mergeSessionInventoryWorkspacePage(draft, {
          workspaceKey: "/repo/a",
          directory: "/repo/a",
          rows: [session("ses_new", 2)],
          cursor: null,
        })
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.byWorkspace["/repo/a"].sessions.map((item) => item.id)).toEqual(["ses_old", "ses_new"])
    expect(inventory.byWorkspace["/repo/a"].hasMore).toBe(true)
    expect(inventory.byWorkspace["/repo/a"].nextCursor).toBe(2)
    expect(inventory.workspaceState["/repo/a"].cursor).toBe(2)
  })

  test("runtime workspace replacement replaces only the matching workspace rows", () => {
    setSessionInventoryQueryData({
      baseUrl: "http://test",
      value: {
        ...emptySessionInventory<SessionInventoryRow>(),
        sessions: [
          session("ses_old", 1, { workspaceId: "ws_1", workspaceName: "Workspace" }),
          session("ses_other", 3, { workspaceId: "ws_2", directory: "/repo/b", projectID: "project_b" }),
        ],
        loaded: true,
      },
    })

    updateSessionInventoryQueryData<SessionInventoryRow>({
      baseUrl: "http://test",
      mutate: (draft) => {
        replaceSessionInventoryWorkspaceRows(draft, {
          workspaceKey: "ws_1",
          directory: "/repo/a",
          workspaceName: "Workspace",
          projectID: "project_a",
          rows: [session("ses_new", 6, { workspaceId: "ws_1", workspaceName: "Workspace" })],
          total: 4,
        })
      },
    })

    const inventory = readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })
    expect(inventory.sessionOrder).toEqual(["ses_new", "ses_other"])
    expect(inventory.byWorkspace.ws_1.sessions.map((item) => item.id)).toEqual(["ses_new"])
    expect(inventory.byWorkspace.ws_1.total).toBe(4)
    expect(inventory.byWorkspace.ws_2.sessions.map((item) => item.id)).toEqual(["ses_other"])
  })

  test("notifies inventory subscribers once per writer call", async () => {
    const notifications: string[][] = []
    const observer = new QueryObserver(
      queryClient,
      sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: "http://test" }),
    )
    const unsubscribe = observer.subscribe((result) => {
      if (result.data) notifications.push(result.data.sessionOrder)
    })

    try {
      setSessionInventoryQueryData({
        baseUrl: "http://test",
        value: {
          ...emptySessionInventory<SessionInventoryRow>(),
          sessions: [session("ses_1", 1)],
          loaded: true,
        },
      })
      await Promise.resolve()

      expect(notifications).toEqual([["ses_1"]])
      notifications.length = 0

      updateSessionInventoryQueryData<SessionInventoryRow>({
        baseUrl: "http://test",
        mutate: (draft) => {
          upsertSessionInventoryRow(draft, session("ses_2", 2))
        },
      })
      await Promise.resolve()

      expect(notifications).toEqual([["ses_2", "ses_1"]])
    } finally {
      unsubscribe()
    }
  })

  test("read returns an empty compatible value before the query cache is populated", () => {
    expect(readSessionInventoryQueryData<SessionInventoryRow>({ baseUrl: "http://test" })).toEqual(
      emptySessionInventory<SessionInventoryRow>(),
    )
  })
})

function session(id: string, updated: number, extra: Partial<SessionInventoryRow> = {}): SessionInventoryRow {
  return {
    id,
    title: id,
    directory: "/repo/a",
    projectID: "project_a",
    attachments: [],
    time: { created: updated, updated },
    ...extra,
  }
}

function workspaceGroup(
  directory: string,
  sessions: SessionInventoryRow[],
  extra: Partial<{
    projectID: string
    total: number
    hasMore: boolean
    nextCursor: number
  }> = {},
) {
  return {
    key: directory,
    directory,
    projectID: extra.projectID ?? "project_a",
    sessions,
    hasMore: extra.hasMore ?? false,
    total: extra.total ?? sessions.length,
    nextCursor: extra.nextCursor,
  }
}
