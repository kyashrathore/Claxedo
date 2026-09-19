/**
 * `signedShellProjects` — the hosted shell's projection of authority workspace
 * rows into the project catalog the browser boots from.
 *
 * Reached in production only through `signedProjects`, which returns `[]`
 * unless `options.listWorkspaces` is supplied, so the route tests never enter
 * it.
 */
import { describe, expect, test } from "vitest"
import { signedShellProjects } from "./shell"

describe("signedShellProjects", () => {
  test("a workspace's kind is the placement its row states", () => {
    const projects = signedShellProjects(
      [
        {
          workspace_id: "ws_cloud",
          project_id: "proj_one",
          backing: "cloud-vm",
          workspace_name: "cloud root",
          remote_directory: "/workspace",
        },
        {
          workspace_id: "ws_shared",
          project_id: "proj_one",
          backing: "local-worktree",
          workspace_name: "shared checkout",
        },
      ],
      1_800_000_000_000,
    )

    expect(projects).toHaveLength(1)
    expect(projects[0]?.workspaces).toMatchObject({
      ws_cloud: { id: "ws_cloud", kind: "cloud", directory: "workspace:ws_cloud", remote_directory: "/workspace" },
      ws_shared: { id: "ws_shared", kind: "user-hosted", directory: "workspace:ws_shared" },
    })
  })

  test("a row that states no placement is the provisioner's, never the reader's own machine", () => {
    const projects = signedShellProjects([{ workspace_id: "ws_bare", project_id: "proj_bare" }], 1_800_000_000_000)

    expect(projects[0]?.workspaces).toMatchObject({ ws_bare: { kind: "cloud" } })
  })
})
