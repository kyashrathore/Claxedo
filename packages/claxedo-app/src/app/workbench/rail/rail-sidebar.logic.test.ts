import { describe, expect, test } from "bun:test"
import {
  railProjectCaptionFromName,
  railProjectLabel,
  projectActionDirectory,
  railWorkspaceMetaLabels,
  railWorkspaceSessionBacking,
  sessionProjectSort,
  shouldAutoOpenWorkspaceSection,
  shouldHydrateSidebarRuntime,
  workspaceInventoryGroupFor,
} from "./rail-sidebar.logic"
import type { ProjectItem } from "./domain-types"

function project(overrides: Partial<ProjectItem> & { worktree: string }): ProjectItem {
  return { id: overrides.worktree, ...overrides }
}

// These specs import the REAL derivation functions that rail-sidebar.tsx uses,
// closing the workspace-project-integrity.test.ts drift: that file hand-copied
// a projectLabel() that read `sessions[].git.remote`, while the shipped logic
// derives the label from `workspaces[].repo_url`.
describe("railProjectLabel", () => {
  test("prefers an explicit project name", () => {
    expect(railProjectLabel(project({ worktree: "/repo/main", name: "Custom" }))).toBe("Custom")
  })

  test("derives owner/repo from the first workspace repo_url in iteration order (not from session git remotes)", () => {
    const label = railProjectLabel(
      project({
        worktree: "/home/me/claxedo",
        workspaces: {
          a: { id: "a", directory: "/home/me/claxedo", kind: "local" },
          b: { id: "b", directory: "/home/me/claxedo-ws", kind: "cloud", repo_url: "git@github.com:kyashrathore/Claxedo.git" },
          // A second repo_url-bearing workspace, later in insertion order. `.find()`
          // returns the first match, so `b` must win over `c` — this pins that the
          // first-in-iteration remote is chosen, never the last.
          c: { id: "c", directory: "/home/me/claxedo-other", kind: "cloud", repo_url: "git@github.com:someoneelse/Fork.git" },
        },
      }),
    )
    expect(label).toBe("kyashrathore/Claxedo")
  })

  test("falls back to the worktree folder name when there is no name or repo_url", () => {
    expect(railProjectLabel(project({ worktree: "/home/me/my-project" }))).toBe("my-project")
  })
})

describe("railProjectCaptionFromName", () => {
  test("joins owner/repo and folder when they differ", () => {
    expect(
      railProjectCaptionFromName(
        project({
          worktree: "/home/me/claxedo-checkout",
          workspaces: { a: { id: "a", directory: "/x", kind: "local", repo_url: "https://github.com/kyashrathore/Claxedo" } },
        }),
      ),
    ).toBe("kyashrathore/Claxedo · claxedo-checkout")
  })

  test("collapses to a single token when repo and folder coincide", () => {
    expect(railProjectCaptionFromName(project({ worktree: "/home/me/thing", name: "thing" }))).toBe("thing")
  })

  test("falls back to just the folder when no repo is known", () => {
    expect(railProjectCaptionFromName(project({ worktree: "/home/me/thing" }))).toBe("thing")
  })
})

describe("shouldAutoOpenWorkspaceSection", () => {
  test("opens when there are rows and it was neither auto-opened nor toggled", () => {
    expect(shouldAutoOpenWorkspaceSection({ rows: 2, autoOpened: false, manuallyToggled: false })).toBe(true)
  })

  test("stays closed once manually toggled", () => {
    expect(shouldAutoOpenWorkspaceSection({ rows: 2, autoOpened: false, manuallyToggled: true })).toBe(false)
  })
})

describe("projectActionDirectory", () => {
  const workspaceIdForDirectory = (directory: string) =>
    directory === "/runtime/repo" ? "ws_signed" : undefined

  test("returns the canonical directory when the active route exposes its workspace id", () => {
    expect(projectActionDirectory({
      directories: ["/runtime/repo"],
      activeDirectory: "ws_signed",
      projectWorktree: "/repo/main",
      workspaceIdForDirectory,
    })).toBe("/runtime/repo")
  })

  test("preserves an active directory and otherwise falls back to the first project directory", () => {
    expect(projectActionDirectory({
      directories: ["/runtime/repo", "/runtime/other"],
      activeDirectory: "/runtime/other",
      projectWorktree: "/repo/main",
      workspaceIdForDirectory,
    })).toBe("/runtime/other")
    expect(projectActionDirectory({
      directories: ["/runtime/repo"],
      activeDirectory: "ws_unknown",
      projectWorktree: "/repo/main",
      workspaceIdForDirectory,
    })).toBe("/runtime/repo")
  })
})

describe("railWorkspaceSessionBacking", () => {
  test("uses the signed project workspace when a fresh inventory row omits environment kind", () => {
    expect(railWorkspaceSessionBacking({
      directory: "ws_signed",
      project: project({
        worktree: "/repo/main",
        workspaces: {
          ws_signed: {
            id: "workspace-record",
            workspaceId: "ws_signed",
            directory: "/runtime/repo",
            kind: "cloud",
          },
        },
      }),
    })).toEqual({ workspaceId: "ws_signed", kind: "cloud" })
  })

  test("does not infer signed authority from a local workspace", () => {
    expect(railWorkspaceSessionBacking({
      directory: "/repo/main",
      project: project({
        worktree: "/repo/main",
        workspaces: {
          local: { id: "local", directory: "/repo/main", kind: "local" },
        },
      }),
    })).toBeUndefined()
  })

  test("keeps known-local and UUID workspace associations off the relay", () => {
    const pending = project({
      worktree: "/repo/main",
      workspaces: {
        pending: {
          id: "ws_pending",
          workspaceId: "ws_pending",
          directory: "/runtime/repo",
          kind: "local",
        },
      },
    })

    expect(railWorkspaceSessionBacking({
      directory: "/runtime/repo",
      workspaceId: "ws_pending",
      sessionRef: "workspace:ws_pending:session:ses_pending",
      environmentKind: "local",
      project: pending,
    })).toBeUndefined()

    expect(railWorkspaceSessionBacking({
      directory: "/runtime/repo",
      workspaceId: "608c72e3-405a-4d2a-bf7f-883b8c76ea8e",
      sessionRef: "workspace:608c72e3-405a-4d2a-bf7f-883b8c76ea8e:session:ses_uuid",
      project: pending,
    })).toBeUndefined()

    expect(railWorkspaceSessionBacking({
      directory: "/runtime/repo",
      workspaceId: "ws_pending",
      sessionRef: "workspace:ws_pending:session:ses_pending",
      environmentKind: "local",
      project: project({ worktree: "/repo/main" }),
    })).toEqual({ workspaceId: "ws_pending", kind: "user-hosted" })
  })

  test("keeps canonical central and local session refs off the relay", () => {
    expect(railWorkspaceSessionBacking({
      directory: "/runtime/repo",
      workspaceId: "ws_authz_only",
      sessionRef: "central:ses_authz_only",
      project: project({ worktree: "/repo/main" }),
    })).toBeUndefined()

    expect(railWorkspaceSessionBacking({
      directory: "/repo/main",
      workspaceId: "local-workspace-id",
      sessionRef: "local:/repo/main:session:ses_local",
      project: project({
        worktree: "/repo/main",
        workspaces: {
          local: {
            id: "local-workspace-id",
            workspaceId: "local-workspace-id",
            directory: "/repo/main",
            kind: "local",
          },
        },
      }),
    })).toBeUndefined()
  })
})

describe("sessionProjectSort", () => {
  test("orders terminal-like sessions ahead of regular ones, then by recency", () => {
    const rows = [
      { id: "ses_a", time: 100 },
      { id: "pty_b", time: 1 },
      { id: "ses_c", time: 200 },
    ]
    const sorted = [...rows].sort(sessionProjectSort)
    expect(sorted.map((r) => r.id)).toEqual(["pty_b", "ses_c", "ses_a"])
  })
})

describe("shouldHydrateSidebarRuntime", () => {
  test("hydrates only when open and (active or requested)", () => {
    expect(shouldHydrateSidebarRuntime({ open: true, active: true, requested: false })).toBe(true)
    expect(shouldHydrateSidebarRuntime({ open: false, active: true, requested: true })).toBe(false)
    expect(shouldHydrateSidebarRuntime({ open: true, active: false, requested: false })).toBe(false)
  })
})

describe("workspaceInventoryGroupFor", () => {
  test("resolves a group by workspaceId alias when the directory key misses", () => {
    const groups = {
      "ws_1": { key: "ws_1", workspaceId: "ws_1", sessions: [1] },
    }
    const hit = workspaceInventoryGroupFor({
      groups,
      workspaceDir: "/some/dir",
      workspace: { workspaceId: "ws_1" },
    })
    expect(hit).toBe(groups["ws_1"])
  })
})

describe("railWorkspaceMetaLabels", () => {
  const label = (key: string, role?: string) => key === "role" ? `role:${role}` : key

  /**
   * The whole point of moving role and host state onto the catalog row: a
   * workspace someone else's machine serves says what this account may do with
   * it and whether that machine is up, before any pane opens it.
   */
  test("a teammate's user-hosted workspace reads viewer and host offline with no pane open", () => {
    expect(railWorkspaceMetaLabels({
      kind: "user-hosted",
      role: "viewer",
      hostOnline: false,
      publishedByThisMachine: false,
      label,
    })).toEqual(["hostOffline", "role:viewer", "sharedWithYou"])
  })

  test("the owner's own machine says it publishes the workspace, not that it was shared with them", () => {
    expect(railWorkspaceMetaLabels({
      kind: "user-hosted",
      role: "owner",
      hostOnline: true,
      publishedByThisMachine: true,
      label,
    })).toEqual(["publishedByThisMachine"])
  })

  test("an editor on a reachable shared workspace reads its role and nothing about the host", () => {
    expect(railWorkspaceMetaLabels({
      kind: "user-hosted",
      role: "editor",
      hostOnline: true,
      publishedByThisMachine: false,
      label,
    })).toEqual(["role:editor", "sharedWithYou"])
  })

  test("reachability is only asked about a machine someone owns", () => {
    // A cloud workspace's runtime is provisioned on demand; an unknown host
    // state is not an offline one.
    expect(railWorkspaceMetaLabels({
      kind: "cloud", role: "editor", publishedByThisMachine: false, label,
    })).toEqual([])
    expect(railWorkspaceMetaLabels({
      kind: "user-hosted", role: "owner", publishedByThisMachine: false, label,
    })).toEqual([])
  })

  test("keeps the workspace status the catalog already reported, first", () => {
    expect(railWorkspaceMetaLabels({
      kind: "user-hosted",
      status: "offline",
      role: "viewer",
      hostOnline: false,
      publishedByThisMachine: false,
      label,
    })).toEqual(["offline", "hostOffline", "role:viewer", "sharedWithYou"])
  })
})
