import { describe, expect, test } from "bun:test"
import {
  loadSessionInventory,
  removeSessionInventorySession,
} from "./session-inventory"
import { emptySessionInventoryStore, normalizeSessionInventory, type SessionInventoryValue } from "./queries"
import { sessionRow } from "../query/test-support/session-row"
import { mergeWorkspaceGroups, shouldUseSignedSessionInventory, workspaceGroupKey } from "./inventory-source"
import type { WorkspaceGroup } from "@/features/session/data/sync/global-sync-types"

const globalChat = sessionRow({ id: "ses-global", directory: "global", title: "Global" })
const globalKeep = sessionRow({ id: "ses-global-keep", directory: "global", title: "Keep" })
const archived = sessionRow({ id: "ses-archive", directory: "/repo/a", projectID: "project_a" })
const kept = sessionRow({ id: "ses-keep", directory: "/repo/a", projectID: "project_a" })
const other = sessionRow({ id: "ses-other", directory: "/repo/b", projectID: "project_b" })

function inventory(): SessionInventoryValue {
  const sessions = [globalChat, globalKeep, archived, kept, other]
  return normalizeSessionInventory({
    sessions,
    sessionOrder: sessions.map((session) => session.id),
    global: [globalChat, globalKeep],
    globalState: { hasMore: false, loading: false },
    byProject: {
      project_a: [archived, kept],
      project_b: [other],
    },
    projectState: {},
    byWorkspace: {
      "/repo/a": {
        directory: "/repo/a",
        projectID: "project_a",
        sessions: [archived, kept],
        hasMore: false,
        total: 2,
      },
      "/repo/b": {
        directory: "/repo/b",
        projectID: "project_b",
        sessions: [other],
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
    const sessions = Array.from({ length: 8 }, (_, index) => sessionRow({
      id: `ses-${8 - index}`,
      directory: "/repo/a",
      projectID: "project_a",
      time: { created: 8 - index, updated: 8 - index },
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

  test("reconciles paged workspace rows by scoped identity when opaque session ids collide", () => {
    const first = { id: "shared", directory: "/repo/a", workspaceId: "ws_a", projectID: "project_a", time: { updated: 1 } }
    const second = { id: "shared", directory: "/repo/b", workspaceId: "ws_b", projectID: "project_b", time: { updated: 2 } }
    const next = normalizeSessionInventory({
      ...emptySessionInventoryStore<typeof first>(),
      sessions: [first, second],
      sessionOrder: [first.id, second.id],
      global: [],
      byProject: {},
      byWorkspace: {
        ws_a: { directory: first.directory, workspaceId: first.workspaceId, projectID: first.projectID, sessions: [first], hasMore: true, total: 2 },
        ws_b: { directory: second.directory, workspaceId: second.workspaceId, projectID: second.projectID, sessions: [second], hasMore: true, total: 3 },
      },
    })

    expect(next.byWorkspace.ws_a.sessions).toEqual([first])
    expect(next.byWorkspace.ws_b.sessions).toEqual([second])
    expect(next.byWorkspace.ws_a.total).toBe(2)
    expect(next.byWorkspace.ws_b.total).toBe(3)
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

  /**
   * The inventory has one reader left: the snapshot that seeds which rail
   * sections open. Rendered rows, pagination, and freshness belong to each
   * section's own source (`session-source.ts`) instead, so this boundary has
   * no reload or paginator to test — that is not a gap, it is the boundary.
   */
  test("routes the one remaining loader call through the shell data boundary", async () => {
    const calls: unknown[] = []
    const source = {
      inventoryActions: {
        load: () => {
          calls.push(["load"])
        },
      },
    }

    await loadSessionInventory(source)

    expect(calls).toEqual([["load"]])
  })

  test("loopback-local control sessions coexist with signed-workspace sessions in the derived inventory", () => {
    // Replaces a former source-regex assertion against context/global-sync.tsx.
    // The real contract: deriving the inventory when BOTH a loopback-local
    // session (no workspaceId — keyed by its directory) and a signed-workspace
    // session (keyed by its workspaceId) are present keeps both. A signed
    // workspace never evicts local control sessions from the grouped output.
    const derived = normalizeSessionInventory({
      ...emptySessionInventoryStore(),
      sessions: [
        sessionRow({ id: "ses-local", directory: "/repo/local", projectID: "local_proj", time: { created: 3, updated: 3 } }),
        sessionRow({ id: "ses-signed", directory: "/repo/signed", workspaceId: "ws_signed", projectID: "signed_proj", time: { created: 2, updated: 2 } }),
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
    // Merge-layer counterpart to the derivation test above (which only
    // exercises normalizeSessionInventory). This guards two things about the
    // reload merge path: (1) a loopback control plane does not swap the local
    // session list for a signed-only snapshot, and (2) merging signed
    // workspace groups in never evicts the local control sessions. Both
    // halves are asserted here against the real inventory-source exports the
    // reload path uses.
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
