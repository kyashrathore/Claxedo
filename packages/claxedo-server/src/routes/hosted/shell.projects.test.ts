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
  test("a workspace carries the backing its row states, and no kind of its own", () => {
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
      ws_cloud: { id: "ws_cloud", backing: "cloud-vm", directory: "workspace:ws_cloud", remote_directory: "/workspace" },
      ws_shared: { id: "ws_shared", backing: "local-worktree", directory: "workspace:ws_shared" },
    })
    expect(Object.values(projects[0].workspaces)).not.toContainEqual(expect.objectContaining({ kind: expect.anything() }))
  })

  test("a row that states no placement is the provisioner's, never the reader's own machine", () => {
    const projects = signedShellProjects([{ workspace_id: "ws_bare", project_id: "proj_bare" }], 1_800_000_000_000)

    expect(projects[0]?.workspaces).toMatchObject({ ws_bare: { backing: "cloud-vm" } })
  })
})
