import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AgentPresentationSession as Session } from "@claxedo/agent-runtime-contract"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { createDirectoryCacheManager } from "@/platform/sync/directory-cache-manager"
import { bootstrapDirectory } from "@/app/boot/data/bootstrap"

type DirectorySdk = Parameters<typeof bootstrapDirectory>[0]["sdk"]

function session(input: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    slug: "ses-1",
    projectID: "proj_1",
    directory: "/tmp/ws",
    title: "Cached Session",
    version: "0.0.0",
    time: { created: 1, updated: 2 },
    ...input,
  }
}

function directorySdk(calls: string[]): DirectorySdk {
  return {
    project: { ensure: async () => (calls.push("project"), { data: { id: "proj_1", worktree: "/tmp/ws", time: { created: 1, updated: 1 }, sandboxes: [] } }) },
    path: { get: async () => (calls.push("path"), { data: { state: "", config: "", worktree: "", directory: "/tmp/ws", home: "" } }) },
    command: { list: async () => (calls.push("command"), { data: [] }) },
    vcs: { get: async () => (calls.push("vcs"), { data: undefined }) },
  }
}

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  queryClient.clear()
  vi.clearAllTimers()
  vi.useRealTimers()
  localStorage.clear()
})

describe("global sync bootstrap integration", () => {
  test("cached child data is synchronous and bootstrap loads inventory with the explicit provider capability", async () => {
    queryClient.setQueryData(queryKeys.directory.projectMeta("/tmp/ws"), { name: "Cached" })
    queryClient.setQueryData(queryKeys.directory.icon("/tmp/ws"), "triangle")
    queryClient.setQueryData(queryKeys.directory.sessionCache("/tmp/ws"), {
      at: 1,
      limit: 5,
      total: 1,
      session: [session()],
    })

    const calls: string[] = []
    const manager = createDirectoryCacheManager({
      isBooting: () => false,
      isLoadingSessions: () => false,
      onDispose: () => {},
      translate: (key) => key,
    })
    const cache = manager.sessionCache("/tmp/ws")

    expect(queryClient.getQueryData(queryKeys.directory.projectMeta("/tmp/ws"))).toEqual({ name: "Cached" })
    expect(queryClient.getQueryData(queryKeys.directory.icon("/tmp/ws"))).toBe("triangle")
    expect(cache.session.map((item) => item.id)).toEqual(["ses_1"])

    await bootstrapDirectory({
      directory: "/tmp/ws",
      sdk: directorySdk(calls),
      loadSessions: async () => {
        calls.push("inventory")
      },
      translate: (key) => key,
      baseUrl: "http://claxedo.test",
      harnessType: "pi",
      fetch: async (input) => {
        const req = input instanceof Request ? input : new Request(String(input))
        calls.push(req.url.includes("/api/workspace/resolve") ? "workspace_resolve" : req.url)
        if (req.url === "http://claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi") {
          return Response.json({ all: [], connected: [], default: {} })
        }
        if (req.url.startsWith("http://claxedo.test/api/claxedo/agent-config/agents?") ||
          req.url === "http://claxedo.test/api/claxedo/agent-config/commands") return Response.json([])
        throw new Error(`Unexpected bootstrap request: ${req.url}`)
      },
    })

    expect(calls).toEqual(["inventory", "http://claxedo.test/api/claxedo/agent-config/providers?nativeHarness=pi"])

    await vi.advanceTimersByTimeAsync(1)

    expect(calls).toContain("vcs")
    expect(calls).not.toContain("mcp")
    expect(calls.some((item) => item.endsWith("/config"))).toBe(false)
    expect(queryClient.getQueryCache().getAll().some((query) => query.queryKey[2] === "config")).toBe(false)
    expect(calls.filter((item) => item === "inventory")).toHaveLength(1)
  })
})
