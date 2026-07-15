import { describe, expect, test } from "bun:test"
import { workGraphExecutionContext } from "./workgraph-execution-context"

describe("workGraphExecutionContext", () => {
  test("infers local and hosted Stream targets from project context", () => {
    expect(workGraphExecutionContext("/Users/me/claxedo", [{ worktree: "/Users/me/claxedo" }])).toEqual({
      kind: "local_worktree",
      directory: "/Users/me/claxedo",
    })
    expect(workGraphExecutionContext("workspace:ws_cloud", [{
      worktree: "/Users/me/claxedo",
      git: { remote: "https://github.com/claxedo/fallback.git" },
      workspaces: {
        "workspace:ws_cloud": {
          id: "ws_cloud",
          kind: "cloud",
          repo_url: "https://github.com/claxedo/project.git",
        },
      },
    }])).toEqual({
      kind: "hosted_workspace",
      repositoryUrl: "https://github.com/claxedo/project.git",
    })
  })
})
