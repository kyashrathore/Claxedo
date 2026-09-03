import { describe, expect, test } from "bun:test"

import { describeLocalWorkspace } from "./local-workspace-description"

const daemon = (rows: unknown[]) =>
  (async () => Response.json({ workspaces: rows })) as unknown as typeof fetch

describe("describeLocalWorkspace", () => {
  test("names the workspace from the daemon's own record", async () => {
    const description = await describeLocalWorkspace("http://127.0.0.1:2593", "ws_1", daemon([
      { workspaceId: "ws_1", workspaceName: null, directory: "/Users/me/test/opencode", backing: { repoName: "Claxedo", branch: "dev" } },
    ]))
    expect(description).toEqual({ displayName: "Claxedo", directory: "/Users/me/test/opencode", repoName: "Claxedo", gitBranch: "dev" })
  })

  test("prefers the workspace's own name, then the folder when there is no repository", async () => {
    const named = await describeLocalWorkspace("http://d", "ws_1", daemon([{ workspaceId: "ws_1", workspaceName: "Docs", directory: "/x/docs", backing: { repoName: "r" } }]))
    expect(named?.displayName).toBe("Docs")
    const folder = await describeLocalWorkspace("http://d", "ws_2", daemon([{ workspaceId: "ws_2", directory: "/x/notes", backing: null }]))
    expect(folder).toEqual({ displayName: "notes", directory: "/x/notes" })
  })

  test("answers undefined for a workspace this machine does not have", async () => {
    await expect(describeLocalWorkspace("http://d", "ws_missing", daemon([{ workspaceId: "ws_1", directory: "/x" }]))).resolves.toBeUndefined()
  })
})
