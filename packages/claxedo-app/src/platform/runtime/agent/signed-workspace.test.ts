import { describe, expect, test } from "bun:test"
import { signedWorkspaceFromProjects } from "./signed-workspace"

describe("signed workspace lookup", () => {
  test("matches raw workspace ids from cached project metadata", () => {
    expect(
      signedWorkspaceFromProjects(
        [
          {
            workspaces: {
              "/tmp/project": {
                workspaceId: "ws_cached",
                kind: "cloud",
                directory: "/tmp/project",
              },
            },
          },
        ],
        "ws_cached",
      ),
    ).toEqual({
      workspaceId: "ws_cached",
      directory: "/tmp/project",
      workspaceName: undefined,
      kind: "cloud",
    })
  })

  test("returns a stable object for repeated lookups in the same project inventory", () => {
    const projects = [
      {
        workspaces: {
          "/tmp/project": {
            workspaceId: "ws_cached",
            kind: "cloud",
            directory: "/tmp/project",
          },
        },
      },
    ]

    expect(signedWorkspaceFromProjects(projects, "/tmp/project")).toBe(
      signedWorkspaceFromProjects(projects, "/tmp/project"),
    )
  })
})
