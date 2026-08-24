import { afterEach, describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  directorySessionCache,
  directorySessionCacheQuery,
  directorySessions,
  ensureDirectorySessionCache,
  focusDirectorySessionCache,
  hydrateDirectorySession,
  removeDirectorySession,
  removeDirectorySessionTree,
  refreshDirectorySessionCache,
  reconcileUnrevertedDirectorySession,
  sessionLoadMetaKey,
  setDirectorySessionCache,
  updateDirectorySession,
  upsertDirectorySession,
  useDirectorySessionCacheActions,
} from "./directory-session-cache"
import { directorySessionCacheQueryOptions } from "./queries"
import { queryClient } from "@/platform/query/query-client"

afterEach(() => {
  queryClient.clear()
})

function session(input: { id: string; parentID?: string }): Session {
  return {
    id: input.id,
    parentID: input.parentID,
    time: { created: 1, updated: 1 },
  } as Session
}

describe("directory session-cache shell-data boundary", () => {
  test("exposes the disabled session cache query under the shell-data owner", () => {
    expect(directorySessionCacheQuery("/workspace/project")).toMatchObject({
      queryKey: directorySessionCacheQueryOptions({ directory: "/workspace/project" }).queryKey,
      enabled: false,
    })
  })

  test("ensure forwards quiet speculative refreshes", async () => {
    queryClient.removeQueries({
      queryKey: directorySessionCacheQueryOptions({ directory: "/missing-workspace" }).queryKey,
      exact: true,
    })
    const calls: unknown[] = []

    await ensureDirectorySessionCache({
      directory: "/missing-workspace",
      refresh: (...args) => {
        calls.push(args)
      },
      quiet: true,
    })

    expect(calls).toEqual([["/missing-workspace", undefined, { quiet: true }]])
  })

  test("refresh keeps explicit loads loud unless the caller opts into quiet", async () => {
    const calls: unknown[] = []

    await refreshDirectorySessionCache({
      directory: "/workspace/project",
      refresh: (...args) => {
        calls.push(args)
      },
    })

    expect(calls).toEqual([["/workspace/project", undefined, { quiet: undefined }]])
  })

  test("forwards explicit signed workspace backing without adding it to local refreshes", async () => {
    const calls: unknown[] = []

    await refreshDirectorySessionCache({
      directory: "/workspace/project",
      refresh: (...args) => {
        calls.push(args)
      },
      workspace: { workspaceId: "ws_signed", kind: "user-hosted" },
    })

    expect(calls).toEqual([
      [
        "/workspace/project",
        undefined,
        { quiet: undefined, workspace: { workspaceId: "ws_signed", kind: "user-hosted" } },
      ],
    ])
  })

  test("refreshes a pre-populated local cache once when signed workspace authority arrives", async () => {
    const directory = "/workspace/project"
    const workspace = { workspaceId: "ws_signed", kind: "user-hosted" } as const
    const calls: unknown[] = []
    setDirectorySessionCache(directory, { at: 1, limit: 50, total: 0, session: [] })
    queryClient.setQueryData(sessionLoadMetaKey(directory), { limit: 50 })

    await ensureDirectorySessionCache({
      directory,
      workspace,
      refresh: (...args) => calls.push(args),
    })

    expect(calls).toEqual([[directory, undefined, { quiet: undefined, workspace }]])
  })

  test("reuses a pre-populated cache only for the exact signed workspace authority", async () => {
    const directory = "/workspace/project"
    const workspace = { workspaceId: "ws_signed", kind: "user-hosted" } as const
    const calls: unknown[] = []
    setDirectorySessionCache(directory, { at: 1, limit: 50, total: 0, session: [] })
    queryClient.setQueryData(sessionLoadMetaKey(directory), { limit: 50, workspace })

    await ensureDirectorySessionCache({
      directory,
      workspace,
      refresh: (...args) => calls.push(args),
    })
    await ensureDirectorySessionCache({
      directory,
      workspace: { ...workspace, kind: "cloud" },
      refresh: (...args) => calls.push(args),
    })

    expect(calls).toEqual([
      [directory, undefined, { quiet: undefined, workspace: { workspaceId: "ws_signed", kind: "cloud" } }],
    ])
  })

  test("keeps an existing local cache warm without provenance metadata", async () => {
    const directory = "/workspace/project"
    const calls: unknown[] = []
    setDirectorySessionCache(directory, { at: 1, limit: 50, total: 0, session: [] })

    await ensureDirectorySessionCache({
      directory,
      refresh: (...args) => calls.push(args),
    })

    expect(calls).toEqual([])
  })

  test("hook-level ensure defaults to quiet while refresh does not", async () => {
    const source = await Bun.file(new URL("./directory-session-cache.ts", import.meta.url)).text()

    expect(source).toContain("quiet: input.quiet ?? true")
    expect(source).toMatch(
      /refresh:\s*\(input: \{ directory: string; harnessType\?: string; quiet\?: boolean; workspace\?: WorkspaceSessionBacking \}\) =>[\s\S]{0,180}refreshDirectorySessionCache/,
    )
    expect(source).not.toMatch(/refresh:[\s\S]{0,180}quiet: input\.quiet \?\? true/)
    void useDirectorySessionCacheActions
  })

  test("forwards focused directory updates to the cache refresh queue owner", () => {
    const calls: Array<string | undefined> = []

    focusDirectorySessionCache({
      source: {
        setFocusedDirectory: (directory) => {
          calls.push(directory)
        },
      },
      directory: "/workspace/project",
    })

    focusDirectorySessionCache({
      source: {
        setFocusedDirectory: (directory) => {
          calls.push(directory)
        },
      },
    })

    expect(calls).toEqual(["/workspace/project", undefined])
  })

  test("owns directory session cache writes", () => {
    setDirectorySessionCache("/workspace/project", {
      at: 1,
      limit: 10,
      total: 1,
      session: [session({ id: "ses_1" })],
    })

    upsertDirectorySession("/workspace/project", session({ id: "ses_2" }))
    updateDirectorySession("/workspace/project", "ses_2", (item) => ({ ...item, title: "Updated" }))
    removeDirectorySession("/workspace/project", "ses_1")

    expect(directorySessions("/workspace/project")).toMatchObject([{ id: "ses_2", title: "Updated" }])
  })

  test("hydrates a missing child from the canonical session endpoint without changing the root total", async () => {
    setDirectorySessionCache("/workspace/project", {
      at: 1,
      limit: 10,
      total: 1,
      session: [session({ id: "ses_root" })],
    })
    const calls: unknown[] = []

    const result = await hydrateDirectorySession({
      directory: "/workspace/project",
      sessionID: "ses_child",
      getSession: async (parameters) => {
        calls.push(parameters)
        return session({ id: "ses_child", parentID: "ses_root" })
      },
    })

    expect(calls).toEqual([{ directory: "/workspace/project", sessionID: "ses_child" }])
    expect(result).toMatchObject({ id: "ses_child", parentID: "ses_root" })
    expect(directorySessionCache("/workspace/project")).toMatchObject({
      total: 1,
      session: [{ id: "ses_child", parentID: "ses_root" }, { id: "ses_root" }],
    })
  })

  test("returns a cached session without fetching it again", async () => {
    const cached = session({ id: "ses_child", parentID: "ses_root" })
    setDirectorySessionCache("/workspace/project", {
      at: 1,
      limit: 10,
      total: 1,
      session: [cached],
    })
    let calls = 0

    const result = await hydrateDirectorySession({
      directory: "/workspace/project",
      sessionID: "ses_child",
      getSession: async () => {
        calls++
        return undefined
      },
    })

    expect(result).toBe(cached)
    expect(calls).toBe(0)
  })

  test("clears a stale revert marker from an authoritative unrevert response", () => {
    setDirectorySessionCache("/workspace/project", {
      at: 1,
      limit: 10,
      total: 1,
      session: [{ ...session({ id: "ses_1" }), revert: { messageID: "msg_2" }, title: "Current" }],
    })

    reconcileUnrevertedDirectorySession({
      directory: "/workspace/project",
      canonical: { ...session({ id: "ses_1" }), title: "Canonical" },
    })

    expect(directorySessions("/workspace/project")[0]).toMatchObject({ id: "ses_1", title: "Canonical" })
    expect(directorySessions("/workspace/project")[0]?.revert).toBeUndefined()
  })

  test("removes child sessions with a deleted root", () => {
    setDirectorySessionCache("/workspace/project", {
      at: 1,
      limit: 10,
      total: 2,
      session: [
        session({ id: "ses_root" }),
        session({ id: "ses_child", parentID: "ses_root" }),
        session({ id: "ses_other" }),
      ],
    })

    expect([...removeDirectorySessionTree("/workspace/project", "ses_root")].sort()).toEqual(["ses_child", "ses_root"])
    expect(directorySessions("/workspace/project").map((item) => item.id)).toEqual(["ses_other"])
  })
})
