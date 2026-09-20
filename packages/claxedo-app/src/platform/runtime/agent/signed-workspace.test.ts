import { describe, expect, test } from "bun:test"
import { localWorkspaceInProjects, signedWorkspaceFromProjects } from "./signed-workspace"

describe("signed workspace lookup", () => {
  test("matches raw workspace ids from cached project metadata", () => {
    expect(signedWorkspaceFromProjects([
      {
        workspaces: {
          "/tmp/project": {
            workspaceId: "ws_cached",
            kind: "cloud",
            directory: "/tmp/project",
          },
        },
      },
    ], "ws_cached")).toEqual({
      workspaceId: "ws_cached",
      directory: "/tmp/project",
      workspaceName: undefined,
      kind: "provisioner",
    })
  })

  test("returns a stable object for repeated lookups in the same project inventory", () => {
    const projects = [{
      workspaces: {
        "/tmp/project": {
          workspaceId: "ws_cached",
          kind: "cloud",
          directory: "/tmp/project",
        },
      },
    }]

    expect(signedWorkspaceFromProjects(projects, "/tmp/project")).toBe(
      signedWorkspaceFromProjects(projects, "/tmp/project"),
    )
  })

  test("normalizes nullable control-plane workspace fields at the inventory boundary", () => {
    expect(signedWorkspaceFromProjects([{
      workspaces: {
        ws_nullable: {
          id: null,
          workspaceId: "ws_nullable",
          kind: "user-hosted",
          directory: null,
          workspace_name: null,
          workspaceName: null,
        },
      },
    }], "ws_nullable")).toEqual({
      workspaceId: "ws_nullable",
      directory: "ws_nullable",
      kind: "machine",
    })
  })

  test("treats a filesystem project's own UUID as local, not relay-backed", () => {
    const projectId = "c4955849-a3c1-4f3e-8481-1fd1bdec3962"
    const worktree = "/private/tmp/claxedo-agent-plugins-real-app/plugins-e2e"
    const projects = [{
      id: projectId,
      worktree,
      workspaces: {
        [worktree]: { id: projectId, directory: worktree, kind: "local" },
      },
    }]

    expect(localWorkspaceInProjects(projects, projectId)).toBe(true)
    expect(localWorkspaceInProjects(projects, worktree)).toBe(true)
    expect(signedWorkspaceFromProjects(projects, projectId)).toBeUndefined()
  })

  // The exact grouping `signedBootstrapProjects` answers with
  // (`claxedo-local-server/src/deployments/shared-routes/bootstrap.ts`), and the
  // same shape the hosted shell's `signedShellProjects` serves: every entry
  // states `backing` and no `kind`, is addressed by `workspace:<id>`, and
  // carries no `placement`.
  const bootstrapProjects = [{
    id: "prj_1",
    name: "prj_1",
    worktree: "ws_machine",
    sandboxes: ["ws_machine", "ws_sandbox"],
    workspaces: {
      ws_machine: {
        id: "ws_machine",
        backing: "local-worktree",
        workspace_name: "Main",
        directory: "workspace:ws_machine",
        remote_directory: "/Users/host/repo",
      },
      ws_sandbox: {
        id: "ws_sandbox",
        backing: "cloud-vm",
        workspace_name: "Sandbox",
        directory: "workspace:ws_sandbox",
      },
    },
  }]

  test("resolves a signed bootstrap row, which states backing and no kind", () => {
    expect(signedWorkspaceFromProjects(bootstrapProjects, "workspace:ws_machine")).toEqual({
      workspaceId: "ws_machine",
      directory: "workspace:ws_machine",
      workspaceName: "Main",
      kind: "machine",
    })
    expect(signedWorkspaceFromProjects(bootstrapProjects, "ws_sandbox")?.kind).toBe("provisioner")
  })

  // A bootstrap row's `local-worktree` names a machine the relay reaches, never
  // the server this client is attached to, so it must not read as local — the
  // caller would then refuse to open a relay it does need.
  test("a machine-placed bootstrap row is not a workspace this server serves", () => {
    expect(localWorkspaceInProjects(bootstrapProjects, "workspace:ws_machine")).toBe(false)
  })

  // The daemon's own store has a `kind` column and no backing, so both
  // vocabularies are in circulation and both resolve through one narrower.
  test("a daemon store row, which states kind and no backing, resolves the same placements", () => {
    const daemonProjects = [{
      id: "prj_2",
      worktree: "/repo/main",
      workspaces: {
        "/repo/main": { id: "ws_own", kind: "local", directory: "/repo/main" },
        "/repo/sandbox": { id: "ws_cloud", kind: "cloud", directory: "/repo/sandbox" },
      },
    }]

    expect(localWorkspaceInProjects(daemonProjects, "/repo/main")).toBe(true)
    expect(signedWorkspaceFromProjects(daemonProjects, "/repo/sandbox")?.kind).toBe("provisioner")
  })

  test("treats a desktop project UUID as local even when inventory omitted kind: local", () => {
    const projectId = "b0b33e8a-8f25-4ce6-b9a8-e06d31a7caf3"
    const worktree = "/tmp/claxedo-agent-plugins-real-app/project-three"
    const projects = [{
      id: projectId,
      worktree,
      workspaces: {
        [worktree]: { id: projectId, directory: worktree },
      },
    }]

    expect(localWorkspaceInProjects(projects, projectId)).toBe(true)
    expect(localWorkspaceInProjects(projects, worktree)).toBe(true)
  })
})
