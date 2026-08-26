import { describe, expect, test } from "bun:test"
import {
  projectDisplayName,
  projectWorkspaceDirectories,
  workspaceRouteIdentity,
  workspaceDisplayName,
  workspaceIsCloud,
  type WorkspaceDisplayProject,
} from "./workspace-display"
import { parseShellRoute, shellRouteDirectory, workspaceRouteWithId } from "@/platform/identity/route"

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
    expect(projectWorkspaceDirectories(project)).toEqual(["/repo/main", "/repo/feature", "/repo/review"])
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
    const reported = "/w/%2Fprivate%2Ftmp%2Fclaxedo-portability%2Fws_cleantest1-dir/session"
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
