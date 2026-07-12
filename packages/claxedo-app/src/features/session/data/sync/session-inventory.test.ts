import { describe, expect, test } from "bun:test"
import {
  loadMoreSessionInventoryProject,
  loadMoreSessionInventoryWorkspace,
  loadSessionInventory,
  reloadSessionInventory,
  removeSessionInventorySession,
} from "./session-inventory"
import { emptySessionInventoryStore, normalizeSessionInventory, type SessionInventoryValue } from "./queries"
import { mergeWorkspaceGroups, shouldUseSignedSessionInventory, workspaceGroupKey } from "./inventory-source"
import type { WorkspaceGroup } from "@/features/session/data/sync/global-sync-types"

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

  test("loopback-local control sessions coexist with signed-workspace sessions in the derived inventory", () => {
    // Replaces a former source-regex assertion against context/global-sync.tsx.
    // The real contract: deriving the inventory when BOTH a loopback-local
    // session (no workspaceId — keyed by its directory) and a signed-workspace
    // session (keyed by its workspaceId) are present keeps both. A signed
    // workspace never evicts local control sessions from the grouped output.
    type Row = { id: string; directory: string; workspaceId?: string; projectID?: string; time?: { updated?: number } }
    const derived = normalizeSessionInventory<Row>({
      ...emptySessionInventoryStore<Row>(),
      sessions: [
        { id: "ses-local", directory: "/repo/local", projectID: "local_proj", time: { updated: 3 } },
        { id: "ses-signed", directory: "/repo/signed", workspaceId: "ws_signed", projectID: "signed_proj", time: { updated: 2 } },
      ],
      loaded: true,
    })

    expect(derived.sessions.map((session) => session.id).sort()).toEqual(["ses-local", "ses-signed"])
    expect(Object.keys(derived.byWorkspace).sort()).toEqual(["/repo/local", "ws_signed"])
    expect(derived.byWorkspace["/repo/local"].sessions.map((session) => session.id)).toEqual(["ses-local"])
    expect(derived.byWorkspace["ws_signed"].sessions.map((session) => session.id)).toEqual(["ses-signed"])
    expect(derived.byWorkspace["ws_signed"].workspaceId).toBe("ws_signed")
    expect(Object.keys(derived.byProject).sort()).toEqual(["local_proj", "signed_proj"])
  })

  test("a loopback control plane keeps local control sessions through the merge path even when a signed workspace exists", () => {
    // Merge-LAYER counterpart to the derivation test above (which only exercised
    // normalizeSessionInventory). The former source-regex assertion against
    // context/global-sync.tsx guarded two things about the reload merge path:
    // (1) a loopback control plane does NOT swap the local session list for a
    // signed-only snapshot, and (2) merging signed workspace groups in never
    // evicts the local control sessions. Both halves are asserted here against
    // the real inventory-source exports the reload path uses.
    const loopbackBaseUrl = "http://127.0.0.1:4096"

    // (1) In loopback, even with signed access, the inventory does not switch to
    //     the signed-only snapshot — so the local control-session merge path runs.
    expect(
      shouldUseSignedSessionInventory({ hasSignedAccess: true, signedRoute: false, baseUrl: loopbackBaseUrl }),
    ).toBe(false)

    // (2) Merging a signed workspace group into the local groups keeps the local
    //     control session and adds the signed workspace alongside it.
    const localControl: WorkspaceGroup = {
      key: "/repo/local",
      directory: "/repo/local",
      projectID: "local_proj",
      sessions: [controlRow("ses-local", "/repo/local", "local_proj", 3)],
      hasMore: false,
      total: 1,
    }
    const signedWorkspace: WorkspaceGroup = {
      key: "ws_signed",
      directory: "workspace:ws_signed",
      workspaceId: "ws_signed",
      projectID: "signed_proj",
      sessions: [controlRow("ses-signed", "workspace:ws_signed", "signed_proj", 2)],
      hasMore: false,
      total: 1,
    }

    const merged = mergeWorkspaceGroups([localControl], [signedWorkspace])
    const byKey = Object.fromEntries(merged.map((group) => [workspaceGroupKey(group), group]))

    expect(Object.keys(byKey).sort()).toEqual(["/repo/local", "ws_signed"])
    expect(byKey["/repo/local"].sessions.map((session) => session.id)).toEqual(["ses-local"])
    expect(byKey["ws_signed"].sessions.map((session) => session.id)).toEqual(["ses-signed"])
    // The signed merge must not mutate the local control group in place.
    expect(localControl.sessions.map((session) => session.id)).toEqual(["ses-local"])
  })
})

function controlRow(id: string, directory: string, projectID: string, updated: number) {
  return {
    id,
    title: id,
    directory,
    projectID,
    attachments: [],
    time: { created: updated, updated },
  }
}
