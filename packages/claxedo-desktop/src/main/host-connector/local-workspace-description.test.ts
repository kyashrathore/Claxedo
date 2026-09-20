import { describe, expect, test } from "bun:test"

import { describeLocalWorkspace } from "./local-workspace-description"

/**
 * The resolve projection, as `workspaceResponse` in server-core builds it: one
 * row, `workspaceId`/`directory`/`workspaceName` at the top level and the
 * repository fields inside the object `backing`. The list verb's row carries
 * none of that, which is why this reads resolve.
 */
const daemon = (rows: Record<string, unknown>[]) =>
  (async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
    expect(url.pathname).toBe("/api/claxedo/workspace/resolve")
    const wanted = url.searchParams.get("workspaceId")
    const row = rows.find((item) => item.workspaceId === wanted)
    return row ? Response.json(row) : Response.json({ error: { code: "workspace_not_found" } }, { status: 404 })
  }) as unknown as typeof fetch

describe("describeLocalWorkspace", () => {
  test("names the workspace from the daemon's own record", async () => {
    const description = await describeLocalWorkspace("http://127.0.0.1:2593", "ws_1", daemon([
      { workspaceId: "ws_1", workspaceName: null, directory: "/Users/me/test/opencode", backing: { kind: "local-worktree", repoName: "Claxedo", branch: "dev" } },
    ]))
    expect(description).toEqual({ displayName: "Claxedo", directory: "/Users/me/test/opencode", repoName: "Claxedo", gitBranch: "dev" })
  })

  test("prefers the workspace's own name, then the folder when there is no repository", async () => {
    const named = await describeLocalWorkspace("http://d", "ws_1", daemon([{ workspaceId: "ws_1", workspaceName: "Docs", directory: "/x/docs", backing: { kind: "local-worktree", repoName: "r" } }]))
    expect(named?.displayName).toBe("Docs")
    const folder = await describeLocalWorkspace("http://d", "ws_2", daemon([{ workspaceId: "ws_2", directory: "/x/notes", backing: null }]))
    expect(folder).toEqual({ displayName: "notes", directory: "/x/notes" })
  })

  test("answers undefined for a workspace this machine does not have", async () => {
    await expect(describeLocalWorkspace("http://d", "ws_missing", daemon([{ workspaceId: "ws_1", directory: "/x" }]))).resolves.toBeUndefined()
  })

  // The repository fields ride inside `backing`, so a caller handed the list
  // contract's bare word would silently share a workspace with no repo, no
  // branch and the folder name.
  test("a list row in place of the resolve row describes nothing", async () => {
    const listShaped = (async () => Response.json({ workspace_id: "ws_1", backing: "local-worktree", remote_directory: "/x/repo" })) as unknown as typeof fetch
    await expect(describeLocalWorkspace("http://d", "ws_1", listShaped)).resolves.toBeUndefined()
  })
})
