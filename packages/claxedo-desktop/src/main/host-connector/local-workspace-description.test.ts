import { describe, expect, test } from "bun:test"

import { describeLocalWorkspace } from "./local-workspace-description"
import { createDaemonFetch } from "../daemon-request"

/**
 * The resolve projection, as `workspaceResponse` in server-core builds it: one
 * row, `workspaceId`/`directory`/`workspaceName` at the top level and the
 * repository fields inside the object `backing`. The list verb's row carries
 * none of that, which is why this reads resolve.
 */
const daemon = (rows: Record<string, unknown>[]) =>
  createDaemonFetch({
    endpoint: () => ({ origin: "http://127.0.0.1:2593", capability: "daemon-capability" }),
    fetch: async (url, init) => {
      expect(url.pathname).toBe("/api/claxedo/workspace/resolve")
      // The daemon answers this read to the application only.
      expect(new Headers(init.headers).get("x-claxedo-daemon-capability")).toBe("daemon-capability")
      const wanted = url.searchParams.get("workspaceId")
      const row = rows.find((item) => item.workspaceId === wanted)
      return row ? Response.json(row) : Response.json({ error: { code: "workspace_not_found" } }, { status: 404 })
    },
  })

describe("describeLocalWorkspace", () => {
  test("names the workspace from the daemon's own record", async () => {
    const description = await describeLocalWorkspace(daemon([
      { workspaceId: "ws_1", workspaceName: null, directory: "/Users/me/test/opencode", backing: { kind: "local-worktree", repoName: "Claxedo", branch: "dev" } },
    ]), "ws_1")
    expect(description).toEqual({ displayName: "Claxedo", directory: "/Users/me/test/opencode", repoName: "Claxedo", gitBranch: "dev" })
  })

  test("prefers the workspace's own name, then the folder when there is no repository", async () => {
    const named = await describeLocalWorkspace(daemon([{ workspaceId: "ws_1", workspaceName: "Docs", directory: "/x/docs", backing: { kind: "local-worktree", repoName: "r" } }]), "ws_1")
    expect(named?.displayName).toBe("Docs")
    const folder = await describeLocalWorkspace(daemon([{ workspaceId: "ws_2", directory: "/x/notes", backing: null }]), "ws_2")
    expect(folder).toEqual({ displayName: "notes", directory: "/x/notes" })
  })

  test("answers undefined for a workspace this machine does not have", async () => {
    await expect(describeLocalWorkspace(daemon([{ workspaceId: "ws_1", directory: "/x" }]), "ws_missing")).resolves.toBeUndefined()
  })

  // The repository fields ride inside `backing`, so a caller handed the list
  // contract's bare word would silently share a workspace with no repo, no
  // branch and the folder name.
  test("a list row in place of the resolve row describes nothing", async () => {
    const listShaped = createDaemonFetch({
      endpoint: () => ({ origin: "http://127.0.0.1:2593", capability: "daemon-capability" }),
      fetch: async () =>
        Response.json({ workspace_id: "ws_1", backing: "local-worktree", remote_directory: "/x/repo" }),
    })
    await expect(describeLocalWorkspace(listShaped, "ws_1")).resolves.toBeUndefined()
  })
})
