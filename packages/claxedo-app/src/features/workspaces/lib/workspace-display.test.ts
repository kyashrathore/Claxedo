import { describe, expect, test } from "bun:test"
import {
  projectDisplayName,
  projectWorkspaceDirectories,
  projectWorkspaceForRef,
  workspaceRouteIdentity,
  workspaceDisplayName,
  workspaceIsCloud,
  type WorkspaceDisplayProject,
} from "./workspace-display"
import { parseShellRoute, shellRouteDirectory, workspaceRouteWithId, workspaceSessionRoute } from "@/platform/identity/route"
import { workspaceRouteId } from "@/platform/identity/workspace-route"
import { controlPlaneCatalogProjects } from "../data/workspace-catalog"

const project: WorkspaceDisplayProject = {
  id: "p-1",
  name: "Alpha",
  worktree: "/repo/main",
  sandboxes: ["ws-feature"],
  workspaces: {
    "ws-main": { id: "ws-main", directory: "/repo/main", workspace_name: "main", kind: "cloud" },
    "ws-feature": { id: "ws-feature", directory: "/repo/feature", workspace_name: "feature-auth", kind: "local" },
    "/repo/review": { workspace_name: "review", kind: "cloud" },
  },
}

describe("workspace display helpers", () => {
  test("projectDisplayName prefers explicit project name", () => {
    expect(projectDisplayName(project)).toBe("Alpha")
  })

  test("projectWorkspaceDirectories includes canonical workspace directories", () => {
    expect(projectWorkspaceDirectories(project)).toEqual([
      "/repo/main",
      "/repo/feature",
      "/repo/review",
    ])
  })

  test("workspaceIsCloud uses workspace metadata and main fallback", () => {
    expect(workspaceIsCloud(project, "/repo/main")).toBe(true)
    expect(workspaceIsCloud(project, "/repo/review")).toBe(true)
    expect(workspaceIsCloud(project, "/repo/feature")).toBe(false)
    expect(workspaceIsCloud({ ...project, workspaces: {} }, "/repo/main", { mainIsCloud: true })).toBe(true)
  })

  test("workspaceDisplayName does not include environment labels", () => {
    expect(workspaceDisplayName(project, "/repo/main")).toBe("main")
    expect(workspaceDisplayName(project, "/repo/feature")).toBe("feature-auth")
    expect(workspaceDisplayName(project, "/repo/review")).toBe("review")
  })

  test("projectDisplayName falls back to the worktree folder name when there is no explicit name", () => {
    expect(projectDisplayName({ id: "p", worktree: "/home/user/myapp" })).toBe("myapp")
  })

  test("workspaceDisplayName labels the worktree 'main' when no workspace metadata names it", () => {
    expect(workspaceDisplayName({ id: "p", worktree: "/home/user/myapp" }, "/home/user/myapp")).toBe("main")
  })

  test("workspaceDisplayName falls back to a sandbox directory basename when it has no workspace_name", () => {
    const bare: WorkspaceDisplayProject = {
      id: "p",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/worktrees/myapp/feature-1"],
    }
    expect(workspaceDisplayName(bare, "/home/worktrees/myapp/feature-1")).toBe("feature-1")
  })

  test("resolves route identity in both workspace-id and directory directions", () => {
    expect(workspaceRouteIdentity([project], "/repo/feature")).toEqual({
      routeId: "ws-feature",
      directory: "/repo/feature",
    })
    expect(workspaceRouteIdentity([project], "ws-feature")).toEqual({
      routeId: "ws-feature",
      directory: "/repo/feature",
    })
  })

  test("uses the project id as the route identity for a main workspace without nested metadata", () => {
    const mainOnly: WorkspaceDisplayProject = {
      id: "workspace-02-id",
      worktree: "/private/tmp/claxedo-visual-check/workspaces/workspace-02",
    }

    expect(workspaceRouteIdentity([mainOnly], mainOnly.worktree)).toEqual({
      routeId: "workspace-02-id",
      directory: mainOnly.worktree,
    })
    expect(workspaceRouteIdentity([mainOnly], mainOnly.id)).toEqual({
      routeId: "workspace-02-id",
      directory: mainOnly.worktree,
    })
  })

  test("uses the project id when an id-less nested record duplicates the main workspace", () => {
    const project: WorkspaceDisplayProject = {
      id: "ws-uuid",
      worktree: "/repo/main",
      workspaces: {
        "ws-uuid": { directory: "/repo/main" },
      },
    }

    expect(workspaceRouteIdentity([project], project.worktree)).toEqual({
      routeId: "ws-uuid",
      directory: project.worktree,
    })
  })

  test("prefers an explicit workspace id over the project fallback for the main directory", () => {
    const project: WorkspaceDisplayProject = {
      id: "project-id",
      worktree: "/repo/main",
      workspaces: {
        main: { id: "workspace-id", directory: "/repo/main" },
      },
    }

    expect(workspaceRouteIdentity([project], project.worktree)).toEqual({
      routeId: "workspace-id",
      directory: project.worktree,
    })
  })

  test("does not promote a workspace map key into a route id without an explicit workspace id", () => {
    const keyed: WorkspaceDisplayProject = {
      id: "project-id",
      worktree: "/repo/main",
      workspaces: {
        "workspace-map-key": {
          directory: "/repo/feature",
          kind: "local",
        },
      },
    }

    expect(workspaceRouteIdentity([keyed], "/repo/feature")).toEqual({
      routeId: undefined,
      directory: "/repo/feature",
    })
  })

  test("does not use a path-valued legacy project id as a route id", () => {
    const legacy: WorkspaceDisplayProject = {
      id: "/private/tmp/legacy-project",
      worktree: "/private/tmp/legacy-project",
    }

    expect(workspaceRouteIdentity([legacy], legacy.worktree)).toEqual({
      routeId: undefined,
      directory: legacy.worktree,
    })
  })

  test("rejects path-valued identity fields even when they differ from the directory", () => {
    const project: WorkspaceDisplayProject = {
      id: "/private/tmp/legacy-project-alias",
      worktree: "/private/tmp/legacy-project",
      workspaces: {
        nested: {
          id: "C:\\Users\\yash\\workspace",
          directory: "/repo/feature",
        },
      },
    }

    expect(workspaceRouteIdentity([project], project.worktree)).toEqual({
      routeId: undefined,
      directory: project.worktree,
    })
    expect(workspaceRouteIdentity([project], "/repo/feature")).toEqual({
      routeId: undefined,
      directory: "/repo/feature",
    })
  })

  test("rejects multiply encoded path-valued identity fields", () => {
    const project: WorkspaceDisplayProject = {
      id: "%252FUsers%252Fperson%252Fprivate-repo",
      worktree: "/Users/person/private-repo",
    }

    expect(workspaceRouteIdentity([project], project.worktree)).toEqual({
      routeId: undefined,
      directory: project.worktree,
    })
  })

  test("does not choose an arbitrary project id for a shared worktree", () => {
    const projects: WorkspaceDisplayProject[] = [
      { id: "ws-a", worktree: "/workspace" },
      { id: "ws-b", worktree: "/workspace" },
    ]

    expect(workspaceRouteIdentity(projects, "/workspace")).toEqual({
      routeId: undefined,
      directory: "/workspace",
    })
    expect(workspaceRouteIdentity(projects, "ws-b")).toEqual({
      routeId: "ws-b",
      directory: "/workspace",
    })
  })

  test("does not let one nested workspace id win across shared project directories", () => {
    const projects: WorkspaceDisplayProject[] = [
      {
        id: "project-a",
        worktree: "/workspace",
        workspaces: { main: { id: "workspace-a", directory: "/workspace" } },
      },
      { id: "project-b", worktree: "/workspace" },
    ]

    expect(workspaceRouteIdentity(projects, "/workspace")).toEqual({
      routeId: undefined,
      directory: "/workspace",
    })
    expect(workspaceRouteIdentity([projects[0]!], "/workspace")?.routeId).toBe("workspace-a")
    expect(workspaceRouteIdentity([projects[1]!], "/workspace")?.routeId).toBe("project-b")
  })

  // A path-keyed workspace record that carries no `id`/`workspaceId` used to
  // fall back to the map KEY as its `routeId`. For a user-hosted workspace that
  // key is a filesystem path, so the app-shell route-sync canonicalizer at
  // `app-shell-route-sync.ts` compared the path against itself, found them
  // equal, and never rewrote the URL — leaving the user on
  // `/w/%2Fprivate%2Ftmp%2F...%2Fws_cleantest1-dir/session`, which leaks the
  // host's directory layout (and username) into a shareable link. A record with
  // no real id must report NO routeId rather than a directory masquerading as
  // one, so the canonicalizer stays silent instead of confirming a bad URL.
  test("never reports a filesystem path as a workspace routeId", () => {
    const identity = workspaceRouteIdentity([project], "/repo/review")
    expect(identity?.directory).toBe("/repo/review")
    expect(identity?.routeId).toBeUndefined()
  })

  test("resolves a path-keyed record to its real id when the record carries one", () => {
    const hosted: WorkspaceDisplayProject = {
      id: "p-2",
      worktree: "/private/tmp/claxedo-portability",
      workspaces: {
        "/private/tmp/claxedo-portability/ws_cleantest1-dir": {
          workspaceId: "ws_cleantest1",
          directory: "/private/tmp/claxedo-portability/ws_cleantest1-dir",
          kind: "user-hosted",
        },
      },
    }

    expect(workspaceRouteIdentity([hosted], "/private/tmp/claxedo-portability/ws_cleantest1-dir")).toEqual({
      routeId: "ws_cleantest1",
      directory: "/private/tmp/claxedo-portability/ws_cleantest1-dir",
    })
  })

  // End-to-end over the exact URL that was reported: parse the path-shaped
  // `/w/` route, resolve its identity, and rebuild the canonical route the way
  // `app-shell-route-sync.ts` does. This binds the three pieces together so a
  // regression in any one of them fails here rather than only in the browser.
  test("canonicalizes a reported user-hosted path URL to its workspace id", () => {
    const reported =
      "/w/%2Fprivate%2Ftmp%2Fclaxedo-portability%2Fws_cleantest1-dir/session"
    const hosted: WorkspaceDisplayProject = {
      id: "p-2",
      worktree: "/private/tmp/claxedo-portability",
      workspaces: {
        "/private/tmp/claxedo-portability/ws_cleantest1-dir": {
          workspaceId: "ws_cleantest1",
          directory: "/private/tmp/claxedo-portability/ws_cleantest1-dir",
          kind: "user-hosted",
        },
      },
    }

    const route = parseShellRoute(reported)
    const routeKey = shellRouteDirectory(route)
    const routeId = workspaceRouteIdentity([hosted], routeKey)?.routeId

    expect(routeKey).toBe("/private/tmp/claxedo-portability/ws_cleantest1-dir")
    expect(routeId).toBe("ws_cleantest1")
    expect(routeId).not.toBe(routeKey)
    expect(workspaceRouteWithId(route, routeId!)).toBe("/w/ws_cleantest1/session")
  })

  test("canonicalizes the first navigation instead of exposing a path and swapping later", () => {
    const directory = "/private/tmp/claxedo-visual-check/workspaces/workspace-02"
    const projects: WorkspaceDisplayProject[] = [{ id: "workspace-02-id", worktree: directory }]
    const writes: string[] = []
    const workspaceId = workspaceRouteId(projects, directory)
    if (workspaceId) {
      writes.push(`${workspaceSessionRoute(workspaceId, "ses_f5f6a4e40001P1kqQtnHHMxZfd")}?source=submit`)
    }

    expect(writes).toEqual(["/w/workspace-02-id/session/ses_f5f6a4e40001P1kqQtnHHMxZfd?source=submit"])
    expect(writes.join(" ")).not.toContain("private")
    expect(writes.join(" ")).not.toContain("%2F")
  })

  test("workspaceIsCloud is false for a non-main directory with no workspace metadata", () => {
    const bare: WorkspaceDisplayProject = { id: "p", worktree: "/home/user/myapp", sandboxes: ["/home/user/myapp-x"] }
    expect(workspaceIsCloud(bare, "/home/user/myapp-x")).toBe(false)
  })

  test("projectWorkspaceDirectories returns only the worktree when there are no sandboxes", () => {
    expect(projectWorkspaceDirectories({ id: "p", worktree: "/home/user/myapp" })).toEqual(["/home/user/myapp"])
  })

  test("projectWorkspaceDirectories dedupes a sandbox that resolves to the worktree", () => {
    const dupe: WorkspaceDisplayProject = {
      id: "p",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/user/myapp", "/home/user/myapp-feature"],
    }
    expect(projectWorkspaceDirectories(dupe)).toEqual(["/home/user/myapp", "/home/user/myapp-feature"])
  })
})

describe("projectWorkspaceForRef", () => {
  const workspaces = {
    "/Users/host/repo": { id: "ws_1", workspaceId: "ws_1", directory: "/Users/host/repo", kind: "user-hosted" as const },
  }

  test("one workspace answers to every identity that names it", () => {
    for (const ref of ["/Users/host/repo", "ws_1", "workspace:ws_1"]) {
      expect(projectWorkspaceForRef(workspaces, ref)?.id).toBe("ws_1")
    }
  })

  test("a ref that names nothing, and no ref at all, resolve to nothing", () => {
    expect(projectWorkspaceForRef(workspaces, "workspace:ws_other")).toBeUndefined()
    expect(projectWorkspaceForRef(workspaces, undefined)).toBeUndefined()
    expect(projectWorkspaceForRef(undefined, "ws_1")).toBeUndefined()
  })
})

/**
 * The route and the catalog are one rule, so these run against what the
 * catalog owner ACTUALLY builds rather than a hand-shaped project: a
 * relay-backed workspace is addressed by `workspace:<id>`, and the serving
 * host's path is metadata that addresses nothing.
 */
describe("workspaceRouteIdentity over a control-plane catalog", () => {
  const HOST_PATH = "/Users/host/opencode"
  const projects = controlPlaneCatalogProjects({
    workspaces: [{
      workspace_id: "ws_hosted",
      project_id: "proj_hosted",
      access: "user-hosted",
      remote_directory: HOST_PATH,
      workspace_name: "shared",
    }],
  })

  test("resolves /w/<workspace id> to the workspace's own address", () => {
    expect(workspaceRouteIdentity(projects, "ws_hosted")).toEqual({
      routeId: "ws_hosted",
      directory: "workspace:ws_hosted",
    })
  })

  test("resolves the address back to the same route id, so the URL never churns", () => {
    expect(workspaceRouteIdentity(projects, "workspace:ws_hosted")).toEqual({
      routeId: "ws_hosted",
      directory: "workspace:ws_hosted",
    })
  })

  // The path names a directory on the HOST's filesystem. Resolving it would
  // hand the app an address it cannot reach — every `?directory=` read scoped
  // by it asks this app's server about a path that only exists elsewhere.
  test("the serving host's path is not a route identity", () => {
    expect(workspaceRouteIdentity(projects, HOST_PATH)).toBeUndefined()
    expect(workspaceRouteId(projects, HOST_PATH)).toBeUndefined()
  })

  test("the catalog row answers to its address and to its bare id alike", () => {
    const workspaces = projects[0]?.workspaces
    for (const ref of ["ws_hosted", "workspace:ws_hosted"]) {
      expect(projectWorkspaceForRef(workspaces, ref)?.workspaceId).toBe("ws_hosted")
    }
    expect(projectWorkspaceForRef(workspaces, "workspace:ws_hosted")?.remote_directory).toBe(HOST_PATH)
  })
})
