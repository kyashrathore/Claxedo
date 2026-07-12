import { describe, expect, test } from "bun:test"
import {
  railProjectCaptionFromName,
  railProjectLabel,
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
