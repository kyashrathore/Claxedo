import { beforeEach, describe, expect, test } from "bun:test"
import {
  SIDEBAR_SESSION_STATUS_FRESH_MS,
  abortSidebarSessionStatusBatches,
  pruneSidebarSessionStatusBatches,
  sidebarSessionStatusBatches,
} from "./rail-sidebar-status"
import {
  activateDisclosureFromKeyboard,
  isDisclosureToggleKey,
  isRootWorktreeRef,
  sessionProjectSort,
  shouldAutoOpenWorkspaceSection,
  shouldHydrateSidebarRuntime,
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

describe("sidebar session status batch pruning", () => {
  const fresh = SIDEBAR_SESSION_STATUS_FRESH_MS

  beforeEach(() => {
    sidebarSessionStatusBatches.clear()
  })

  test("drops entries that are past the freshness window", () => {
    const now = 1_000_000
    sidebarSessionStatusBatches.set("dir\0a\0b", { updatedAt: now - fresh - 1 })
    sidebarSessionStatusBatches.set("dir\0a\0b\0c", { updatedAt: now - 1 })

    pruneSidebarSessionStatusBatches(now)

    // The stale one could only ever answer "not fresh", so it can no longer
    // change what the poll does — while the recent one still suppresses a refetch.
    expect(sidebarSessionStatusBatches.has("dir\0a\0b")).toBe(false)
    expect(sidebarSessionStatusBatches.has("dir\0a\0b\0c")).toBe(true)
  })

  test("never drops an entry with a request in flight", () => {
    const now = 1_000_000
    // `updatedAt` starts at 0 while a request is in flight, so an in-flight
    // entry is always "stale" by time — dropping it would lose the de-dupe
    // guard and let the poll fire a duplicate batch request every tick.
    sidebarSessionStatusBatches.set("dir\0a", { updatedAt: 0, inFlight: Promise.resolve() })

    pruneSidebarSessionStatusBatches(now)

    expect(sidebarSessionStatusBatches.has("dir\0a")).toBe(true)
  })

  test("trusted foreground activation aborts every background batch", () => {
    const controller = new AbortController()
    sidebarSessionStatusBatches.set("dir\0a", {
      updatedAt: 10,
      inFlight: new Promise(() => {}),
      controller,
    })

    abortSidebarSessionStatusBatches()

    expect(controller.signal.aborted).toBe(true)
    expect(sidebarSessionStatusBatches.get("dir\0a")).toEqual({ updatedAt: 10 })
  })

  test("collects the permutations left behind by membership churn", () => {
    // The key carries every session id in the group, so each open/close mints
    // a new one and strands its predecessor. Nothing removed them before.
    const now = 1_000_000
    for (let i = 0; i < 200; i++) {
      const ids = Array.from({ length: 20 }, (_, n) => `ses_${i}_${n}`).join("\0")
      sidebarSessionStatusBatches.set(`dir\0${ids}`, { updatedAt: now - fresh - i })
    }
    sidebarSessionStatusBatches.set("dir\0current", { updatedAt: now })

    pruneSidebarSessionStatusBatches(now)

    expect(sidebarSessionStatusBatches.size).toBe(1)
    expect(sidebarSessionStatusBatches.has("dir\0current")).toBe(true)
  })
})
