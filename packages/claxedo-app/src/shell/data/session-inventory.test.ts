import { describe, expect, test } from "bun:test"
import {
  loadMoreSessionInventoryProject,
  loadMoreSessionInventoryWorkspace,
  loadSessionInventory,
  reloadSessionInventory,
  removeSessionInventorySession,
} from "./session-inventory"
import { normalizeSessionInventory, type SessionInventoryValue } from "./queries"

type TestSession = {
  id: string
  directory: string
  projectID?: string
  title?: string
  time?: { updated?: number; created?: number }
}

function inventory(): SessionInventoryValue<TestSession> {
  return normalizeSessionInventory({
    sessions: [],
    sessionOrder: [],
    global: [
      { id: "ses-global", directory: "global", title: "Global" },
      { id: "ses-global-keep", directory: "global", title: "Keep" },
    ],
    globalState: { hasMore: false, loading: false },
    byProject: {
      project_a: [
        { id: "ses-archive", directory: "/repo/a", projectID: "project_a" },
        { id: "ses-keep", directory: "/repo/a", projectID: "project_a" },
      ],
      project_b: [
        { id: "ses-other", directory: "/repo/b", projectID: "project_b" },
      ],
    },
    projectState: {},
    byWorkspace: {
      "/repo/a": {
        directory: "/repo/a",
        projectID: "project_a",
        sessions: [
          { id: "ses-archive", directory: "/repo/a", projectID: "project_a" },
          { id: "ses-keep", directory: "/repo/a", projectID: "project_a" },
        ],
        hasMore: false,
        total: 2,
      },
      "/repo/b": {
        directory: "/repo/b",
          projectID: "project_b",
          sessions: [
          { id: "ses-other", directory: "/repo/b", projectID: "project_b" },
        ],
        hasMore: false,
        total: 1,
      },
    },
    workspaceState: {},
    workspaceOrder: ["/repo/a", "/repo/b"],
    loading: false,
    loaded: true,
  })
}

describe("session inventory query helpers", () => {
  test("preserves a paged workspace group when canonical sessions has more rows", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => ({
      id: `ses-${8 - index}`,
      directory: "/repo/a",
      projectID: "project_a",
      time: { updated: 8 - index },
    }))
    const next = normalizeSessionInventory({
      sessions,
      sessionOrder: sessions.map((session) => session.id),
      global: [],
      globalState: { hasMore: false, loading: false },
      byProject: {},
      projectState: {},
      byWorkspace: {
        "/repo/a": {
          directory: "/repo/a",
          projectID: "project_a",
          sessions: sessions.slice(0, 5),
          hasMore: true,
          total: 8,
          nextCursor: 4,
        },
      },
      workspaceState: {
        "/repo/a": { hasMore: true, loading: false, cursor: 4 },
      },
      workspaceOrder: ["/repo/a"],
      loading: false,
      loaded: true,
    })

    expect(next.sessions.map((session) => session.id)).toEqual([
      "ses-8",
      "ses-7",
      "ses-6",
      "ses-5",
      "ses-4",
      "ses-3",
      "ses-2",
      "ses-1",
    ])
    expect(next.byProject.project_a.map((session) => session.id)).toEqual([
      "ses-8",
      "ses-7",
      "ses-6",
      "ses-5",
      "ses-4",
      "ses-3",
      "ses-2",
      "ses-1",
    ])
    expect(next.byWorkspace["/repo/a"].sessions.map((session) => session.id)).toEqual([
      "ses-8",
      "ses-7",
      "ses-6",
      "ses-5",
      "ses-4",
    ])
    expect(next.byWorkspace["/repo/a"].hasMore).toBe(true)
    expect(next.byWorkspace["/repo/a"].total).toBe(8)
    expect(next.byWorkspace["/repo/a"].nextCursor).toBe(4)
  })

  test("removes a session by root id from canonical rows and derived indexes", () => {
    const next = removeSessionInventorySession(inventory(), {
      id: "ses-archive",
      directory: "/repo/a",
      projectID: "project_a",
    })

    expect(next.sessions.map((session) => session.id)).toEqual(["ses-global", "ses-global-keep", "ses-keep", "ses-other"])
    expect(next.byProject.project_a.map((session) => session.id)).toEqual(["ses-keep"])
    expect(next.byProject.project_b.map((session) => session.id)).toEqual(["ses-other"])
    expect(next.byWorkspace["/repo/a"].sessions.map((session) => session.id)).toEqual(["ses-keep"])
    expect(next.byWorkspace["/repo/a"].total).toBe(1)
    expect(next.byWorkspace["/repo/b"].sessions.map((session) => session.id)).toEqual(["ses-other"])
    expect(next.byWorkspace["/repo/b"].total).toBe(1)
  })

  test("removes a global session without disturbing unrelated rows", () => {
    const next = removeSessionInventorySession(inventory(), {
      id: "ses-global",
      directory: "global",
    })

    expect(next.sessions.map((session) => session.id)).toEqual(["ses-global-keep", "ses-archive", "ses-keep", "ses-other"])
    expect(next.global.map((session) => session.id)).toEqual(["ses-global-keep"])
    expect(next.byProject.project_a.map((session) => session.id)).toEqual(["ses-archive", "ses-keep"])
  })

  test("routes transitional loader calls through one shell data boundary", async () => {
    const calls: unknown[] = []
    const source = {
      inventoryActions: {
        load: () => {
          calls.push(["load"])
        },
        reloadWorkspace: (filter?: unknown) => {
          calls.push(["reloadWorkspace", filter])
        },
        loadMoreWorkspace: (directory: string, filter?: unknown) => {
          calls.push(["loadMoreWorkspace", directory, filter])
        },
        loadMore: (projectID: string, projectWorktree: string, sandboxes: string[]) => {
          calls.push(["loadMoreProject", projectID, projectWorktree, sandboxes])
        },
      },
    }
    const filter = { archived: "active" as const, status: ["working"] }

    await loadSessionInventory(source)
    await reloadSessionInventory(source, filter)
    await loadMoreSessionInventoryWorkspace({
      source,
      directory: "/repo/a",
      filter,
    })
    await loadMoreSessionInventoryProject({
      source,
      projectID: "project_a",
      projectWorktree: "/repo/a",
      sandboxes: ["/repo/a-wt"],
    })

    expect(calls).toEqual([
      ["load"],
      ["reloadWorkspace", filter],
      ["loadMoreWorkspace", "/repo/a", filter],
      ["loadMoreProject", "project_a", "/repo/a", ["/repo/a-wt"]],
    ])
  })

  test("loopback inventory keeps local control sessions even when signed workspaces exist", async () => {
    const source = await Bun.file(new URL("../../context/global-sync.tsx", import.meta.url)).text()

    expect(source).toMatch(/\(signedSnapshot\.projects\.length > 0 \|\| signedWorkspaceProjects\(\)\.length > 0\) &&\s*centralTransportForServer\(globalSDK\.url\) !== "loopback"/)
  })
})
