import { describe, expect, test } from "bun:test"
import {
  activateDisclosureFromKeyboard,
  isDisclosureToggleKey,
  isRootWorktreeRef,
  sessionProjectSort,
  shouldAutoOpenWorkspaceSection,
  shouldHydrateSidebarRuntime,
  unambiguousSessionStatusTarget,
  workspaceInventoryGroupFor,
} from "./rail-sidebar.logic"

describe("shouldAutoOpenWorkspaceSection", () => {
  test("opens when async inventory appears for an untouched empty workspace", () => {
    expect(shouldAutoOpenWorkspaceSection({
      rows: 1,
      autoOpened: false,
      manuallyToggled: false,
    })).toBe(true)
  })

  test("does not reopen after the user manually toggles the workspace", () => {
    expect(shouldAutoOpenWorkspaceSection({
      rows: 1,
      autoOpened: false,
      manuallyToggled: true,
    })).toBe(false)
  })

  test("opens when a terminal appears before sessions load", () => {
    expect(shouldAutoOpenWorkspaceSection({
      rows: 0,
      terminals: 1,
      autoOpened: false,
      manuallyToggled: false,
    })).toBe(true)
  })
})

describe("shouldHydrateSidebarRuntime", () => {
  test("does not hydrate runtime for passively opened central inventory rows", () => {
    expect(shouldHydrateSidebarRuntime({
      open: true,
      active: false,
      requested: false,
    })).toBe(false)
  })

  test("hydrates active or explicitly requested sidebar workspaces", () => {
    expect(shouldHydrateSidebarRuntime({
      open: true,
      active: true,
      requested: false,
    })).toBe(true)
    expect(shouldHydrateSidebarRuntime({
      open: true,
      active: false,
      requested: true,
    })).toBe(true)
  })
})

describe("unambiguousSessionStatusTarget", () => {
  test("returns a unique visible placement", () => {
    const target = { key: "workspace:one", sessionID: "ses_1" }
    expect(unambiguousSessionStatusTarget([target, { key: "workspace:two", sessionID: "ses_2" }], "ses_1")).toBe(target)
  })

  test("refuses to invent placement authority for duplicate ids", () => {
    expect(unambiguousSessionStatusTarget([
      { key: "workspace:one", sessionID: "shared" },
      { key: "workspace:two", sessionID: "shared" },
    ], "shared")).toBeUndefined()
  })
})

describe("sessionProjectSort", () => {
  test("pins terminal-like sessions above newer normal sessions", () => {
    const rows = [
      { id: "ses-new", title: "Normal", time: 30 },
      { id: "pty-old", title: "Shell", time: 10 },
      { id: "ses-terminal-title", title: "Terminal", time: 5 },
      { id: "ses-middle", title: "Normal", time: 20 },
    ].sort(sessionProjectSort)

    expect(rows.map((row) => row.id)).toEqual([
      "pty-old",
      "ses-terminal-title",
      "ses-new",
      "ses-middle",
    ])
  })
})

describe("isRootWorktreeRef", () => {
  test("treats workspace ids that resolve to the project worktree as root", () => {
    expect(isRootWorktreeRef({
      dir: "workspace-main-id",
      projectWorktree: "/repo/main",
      workspace: {
        id: "workspace-main-id",
        directory: "/repo/main",
      },
    })).toBe(true)
  })

  test("allows non-root worktree refs", () => {
    expect(isRootWorktreeRef({
      dir: "workspace-feature-id",
      projectWorktree: "/repo/main",
      workspace: {
        id: "workspace-feature-id",
        directory: "/repo/feature",
      },
    })).toBe(false)
  })
})

describe("workspaceInventoryGroupFor", () => {
  test("prefers a direct directory-keyed inventory group", () => {
    const group = workspaceInventoryGroupFor({
      groups: {
        "/repo/main": {
          key: "/repo/main",
          directory: "/repo/main",
          sessions: [{ id: "ses_main" }],
        },
        ws_main: {
          key: "ws_main",
          directory: "/repo/main",
          workspaceId: "ws_main",
          sessions: [{ id: "ses_workspace" }],
        },
      },
      workspaceDir: "/repo/main",
      workspace: {
        directory: "/repo/main",
        workspaceId: "ws_main",
      },
    })

    expect(group?.sessions.map((session) => session.id)).toEqual(["ses_main"])
  })

  test("resolves workspace-id keyed inventory for a directory section", () => {
    const group = workspaceInventoryGroupFor({
      groups: {
        ws_feature: {
          key: "ws_feature",
          directory: "/repo/feature",
          workspaceId: "ws_feature",
          sessions: [{ id: "ses_feature" }],
        },
      },
      workspaceDir: "/repo/feature",
      workspace: {
        directory: "/repo/feature",
        id: "workspace-row-id",
        workspaceId: "ws_feature",
      },
    })

    expect(group?.sessions.map((session) => session.id)).toEqual(["ses_feature"])
  })

  test("falls back to stored group metadata when the project workspace alias is missing", () => {
    const group = workspaceInventoryGroupFor({
      groups: {
        ws_cached: {
          key: "ws_cached",
          directory: "/repo/cached",
          workspaceId: "ws_cached",
          sessions: [{ id: "ses_cached" }],
        },
      },
      workspaceDir: "/repo/cached",
    })

    expect(group?.sessions.map((session) => session.id)).toEqual(["ses_cached"])
  })
})

describe("isDisclosureToggleKey", () => {
  test("accepts keyboard activation keys for role=button disclosure controls", () => {
    expect(isDisclosureToggleKey("Enter")).toBe(true)
    expect(isDisclosureToggleKey(" ")).toBe(true)
    expect(isDisclosureToggleKey("Space")).toBe(false)
    expect(isDisclosureToggleKey("ArrowRight")).toBe(false)
  })

  test("activates disclosure without leaking the keyboard event to the row", () => {
    const calls: string[] = []

    activateDisclosureFromKeyboard({
      key: "Enter",
      preventDefault: () => calls.push("prevent"),
      stopPropagation: () => calls.push("stop"),
    }, () => calls.push("toggle"))

    activateDisclosureFromKeyboard({
      key: "ArrowRight",
      preventDefault: () => calls.push("prevent-arrow"),
      stopPropagation: () => calls.push("stop-arrow"),
    }, () => calls.push("toggle-arrow"))

    expect(calls).toEqual(["prevent", "stop", "toggle"])
  })
})
