import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import {
  sessionLoadMetaKey,
  type DirectorySessionLoadMeta,
} from "@/features/session/data/sync/directory-session-cache"
import {
  bootstrapSessionRuntimeTarget,
  bootstrapRequestKey,
  createBootstrapOrchestrator,
  runtimeInventoryWorkspaceIdentity,
  sessionInventoryMatchesWorkspace,
  sessionLoadRequestKey,
} from "./bootstrap-orchestrator"

afterEach(() => queryClient.clear())

describe("bootstrapSessionRuntimeTarget", () => {
  test("uses explicit signed workspace backing for the session-list client", () => {
    expect(bootstrapSessionRuntimeTarget({
      workspace: { workspaceId: "ws_signed", kind: "user-hosted" },
    })).toEqual({
      workspaceId: "ws_signed",
      workspaceKind: "user-hosted",
      signedControlPlane: true,
    })
  })

  test("leaves an ordinary local directory on the authoritative local client", () => {
    expect(bootstrapSessionRuntimeTarget({})).toBeUndefined()
  })

  test("only reuses signed inventory proven to belong to the requested workspace", () => {
    const workspace = { workspaceId: "ws_signed", kind: "user-hosted" } as const

    expect(sessionInventoryMatchesWorkspace({ workspaceId: "ws_signed" }, workspace)).toBe(true)
    expect(sessionInventoryMatchesWorkspace({ workspaceId: "ws_other" }, workspace)).toBe(false)
    expect(sessionInventoryMatchesWorkspace({}, workspace)).toBe(false)
    expect(sessionInventoryMatchesWorkspace({ workspaceId: "ws_local" }, undefined)).toBe(true)
  })

  test("does not coalesce a provisional local bootstrap with signed workspace authority", () => {
    const local = bootstrapRequestKey("/workspace/project", "opencode")
    const signed = bootstrapRequestKey("/workspace/project", "opencode", {
      workspaceId: "ws_signed",
      kind: "user-hosted",
    })

    expect(local).not.toEqual(signed)
    expect(local.slice(0, 4)).toEqual(signed.slice(0, 4))
  })

  test("keeps explicit workspace identity when signed inventory has not hydrated", () => {
    expect(runtimeInventoryWorkspaceIdentity({
      directory: "/runtime/repo",
      requestedWorkspace: { workspaceId: "ws_signed", kind: "user-hosted" },
    })).toEqual({
      workspaceId: "ws_signed",
      directory: "/runtime/repo",
      workspaceName: undefined,
    })
  })

  test("a pending local load cannot satisfy a later signed authority request", async () => {
    const directory = "/workspace/project"
    const workspace = { workspaceId: "ws_signed", kind: "user-hosted" } as const
    let releaseLocal!: () => void
    const localPending = new Promise<void>((resolve) => {
      releaseLocal = resolve
    })
    let cache = { at: 0, limit: 50, total: 0, session: [] }
    const writes: unknown[] = []
    const orchestrator = createBootstrapOrchestrator({
      baseUrl: () => "http://127.0.0.1:3001",
      globalSDK: () => ({}) as never,
      children: {
        pin: () => undefined,
        unpin: () => undefined,
        sessionCache: () => cache,
      },
      translate: (key) => key,
      platformFetch: () => undefined,
      ready: () => true,
      setGlobalState: () => undefined,
      initialRouteDirectory: () => undefined,
      hasSignedAccess: () => true,
      workspaceDirectoryRef: () => false,
      workspaceRuntimeRef: () => undefined,
      signedWorkspaceInfo: () => undefined,
      signedInventorySource: { fetchSignedDirectorySessions: async () => [] },
      sessionInventory: () => ({
        byWorkspace: {
          [workspace.workspaceId]: {
            directory,
            workspaceId: workspace.workspaceId,
            projectID: "project",
            sessions: [],
            hasMore: false,
            total: 0,
          },
        },
      }),
      projectFor: () => undefined,
      inventoryRow: (session) => session as never,
      cacheSessions: (_directory, value) => {
        writes.push(value)
        cache = { ...value, at: 1 }
      },
      sessionCacheLimit: () => 50,
      sdkFor: () => ({}) as never,
      localSessionListClient: () => ({}) as never,
      setSessionLoadMeta: (target, value) => queryClient.setQueryData(sessionLoadMetaKey(target), value),
      markGlobalBootstrapFresh: () => undefined,
      replaceRuntimeWorkspaceRows: () => undefined,
    })

    const provisional = queryClient.fetchQuery({
      queryKey: sessionLoadRequestKey(directory),
      queryFn: async () => {
        await localPending
        queryClient.setQueryData<DirectorySessionLoadMeta>(sessionLoadMetaKey(directory), { limit: 50 })
        return null
      },
    })
    const signed = orchestrator.loadSessions(directory, { workspace })
    releaseLocal()
    await Promise.all([provisional, signed])

    expect(queryClient.getQueryData(sessionLoadMetaKey(directory))).toEqual({ limit: 50, workspace })
    expect(writes).toHaveLength(1)
  })
})
