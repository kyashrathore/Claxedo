import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"

import type { ContentMeta } from "../state/types"
import { useRailWorkspacePanelTarget } from "./rail-workspace-panel-target"
import {
  workspacePanelMatchesFocusedPane,
  workspacePanelTopLevelOpenTarget,
} from "./workspace-panel-visual-state"

describe("workspacePanelMatchesFocusedPane", () => {
  test("treats directory aliases in the same pane as one UI target", () => {
    expect(
      workspacePanelMatchesFocusedPane({
        open: true,
        panel: { targetPaneId: "pane-1" },
        target: { workspaceDir: "/repo/main", targetPaneId: "pane-1" },
      }),
    ).toBe(true)
  })

  test("attaches a targetless panel to the focused pane", () => {
    expect(
      workspacePanelMatchesFocusedPane({
        open: true,
        panel: {},
        target: { workspaceDir: "/repo/main", targetPaneId: "pane-1" },
      }),
    ).toBe(true)
  })

  test("keeps a targetless panel active while workbench pane identity is hydrating", () => {
    expect(workspacePanelMatchesFocusedPane({ open: true, panel: {} })).toBe(true)
  })

  test("does not attribute another pane's panel to the focused pane", () => {
    expect(
      workspacePanelMatchesFocusedPane({
        open: true,
        panel: { targetPaneId: "pane-2" },
        target: { workspaceDir: "/repo/main", targetPaneId: "pane-1" },
      }),
    ).toBe(false)
  })
})

describe("workspacePanelTopLevelOpenTarget", () => {
  test("reopens the same workspace on Review without clearing its warm working set", () => {
    expect(workspacePanelTopLevelOpenTarget(
      { workspaceDir: "/repo/main", targetPaneId: "pane-original" },
      { workspaceDir: "/repo/main", targetPaneId: "pane-focused" },
    )).toEqual({ workspaceDir: "/repo/main", targetPaneId: "pane-original", navigator: "files", focus: { kind: "review" } })
  })

  test("retargets a different workspace without duplicating state clearing policy", () => {
    expect(workspacePanelTopLevelOpenTarget(
      { workspaceDir: "/repo/old", targetPaneId: "pane-old" },
      { workspaceDir: "/repo/new", targetPaneId: "pane-new" },
    )).toEqual({ workspaceDir: "/repo/new", targetPaneId: "pane-new", navigator: "files", focus: { kind: "review" } })
  })

  test("preserves an already selected surface", () => {
    expect(workspacePanelTopLevelOpenTarget(
      { workspaceDir: "/repo/main", targetPaneId: "pane-1", navigator: "changes" },
      { workspaceDir: "/repo/main", targetPaneId: "pane-1" },
    )).toEqual({ workspaceDir: "/repo/main", targetPaneId: "pane-1", navigator: "changes", focus: { kind: "review" } })
  })

  test("does not overwrite an unconsumed user focus request", () => {
    expect(workspacePanelTopLevelOpenTarget(
      {
        workspaceDir: "/repo/main",
        targetPaneId: "pane-1",
        focus: { kind: "file", path: "src/pending.ts", intent: "tab", version: 1 },
      },
      { workspaceDir: "/repo/main", targetPaneId: "pane-1" },
    )).toEqual({ workspaceDir: "/repo/main", targetPaneId: "pane-1", navigator: "files" })
  })
})

describe("useRailWorkspacePanelTarget", () => {
  test("content target wins over route, pinned, and default fallbacks", () => {
    withTarget(
      {
        activeDirectory: "/repo/route",
        focusedPaneId: "pane-1",
        panes: [{ id: "pane-1", contentId: "surface-session" }],
        content: sessionMeta("/repo/content"),
        pinned: "/repo/pinned",
        fallback: "/repo/default",
      },
      (target) => {
        expect(target.workspacePanelTargetForPane("pane-1")).toEqual({
          workspaceDir: "/repo/content",
          targetPaneId: "pane-1",
        })
      },
    )
  })

  test("blocked virtual sessions do not fall through to route or worktree fallbacks", () => {
    withTarget(
      {
        activeDirectory: "/repo/route",
        focusedPaneId: "pane-1",
        panes: [{ id: "pane-1", contentId: "surface-central" }],
        content: centralVirtualSessionMeta(),
        pinned: "/repo/pinned",
        fallback: "/repo/default",
      },
      (target) => {
        expect(target.workspacePanelTargetForPane("pane-1")).toBeUndefined()
        expect(target.focusedPanelTarget()).toBeUndefined()
        expect(target.focusedSurfaceWorkspaceToolsBlocked()).toBe(true)
      },
    )
  })

  test("active workspace route wins when no content target exists", () => {
    withTarget(
      {
        activeDirectory: "/repo/route",
        focusedPaneId: "pane-1",
        panes: [{ id: "pane-1" }],
        pinned: "/repo/pinned",
        fallback: "/repo/default",
      },
      (target) => {
        expect(target.workspacePanelTargetForPane("pane-1")).toEqual({
          workspaceDir: "/repo/route",
          targetPaneId: "pane-1",
        })
      },
    )
  })

  test("pinned worktree wins over default worktree", () => {
    withTarget(
      {
        focusedPaneId: "pane-1",
        panes: [{ id: "pane-1" }],
        pinned: "/repo/pinned",
        fallback: "/repo/default",
      },
      (target) => {
        expect(target.workspacePanelTargetForPane("pane-1")).toEqual({
          workspaceDir: "/repo/pinned",
          targetPaneId: "pane-1",
        })
      },
    )
  })

  test("process sentinels are ignored in pinned and default worktrees", () => {
    withTarget(
      {
        focusedPaneId: "pane-1",
        panes: [{ id: "pane-1" }],
        pinned: "__process__",
        fallback: "__process__",
      },
      (target) => {
        expect(target.workspacePanelTargetForPane("pane-1")).toBeUndefined()
      },
    )
  })

  test("focused pane falls back to first visible pane", () => {
    withTarget(
      {
        focusedPaneId: undefined,
        panes: [{ id: "pane-1" }],
        fallback: "/repo/default",
      },
      (target) => {
        expect(target.focusedSplitPaneId()).toBe("pane-1")
        expect(target.focusedPanelTarget()).toEqual({
          workspaceDir: "/repo/default",
          targetPaneId: "pane-1",
        })
      },
    )
  })
})

function withTarget(
  input: {
    activeDirectory?: string
    focusedPaneId?: string
    panes: readonly { id: string; contentId?: string }[]
    content?: ContentMeta
    pinned?: string
    fallback?: string
  },
  run: (target: ReturnType<typeof useRailWorkspacePanelTarget>) => void,
) {
  createRoot((dispose) => {
    run(
      useRailWorkspacePanelTarget({
        state: fakeState(input),
        activeDirectory: () => input.activeDirectory,
      }),
    )
    dispose()
  })
}

function fakeState(input: {
  focusedPaneId?: string
  panes: readonly { id: string; contentId?: string }[]
  content?: ContentMeta
  pinned?: string
  fallback?: string
}) {
  return {
    wb: {
      state: {
        focusedPaneId: input.focusedPaneId,
        panes: input.panes,
      },
      selectors: {
        focusedContent: () => input.content?.id,
        visiblePanes: () => input.panes,
      },
    },
    meta: {
      get: (contentId: string) => (contentId === input.content?.id ? input.content : undefined),
    },
    workspace: {
      paneWorktree: () => ({
        pinned: input.pinned,
        default: input.fallback,
      }),
    },
  }
}

function sessionMeta(workspaceDir: string): ContentMeta {
  return {
    id: "surface-session",
    type: "session",
    scope: "directory",
    directory: workspaceDir,
    sessionId: "ses_surface",
    content: {
      type: "session",
      directory: workspaceDir,
      sessionId: "ses_surface",
      sessionRef: {
        sessionId: "ses_surface",
        host: "workspace",
        cwd: workspaceDir,
        toolSandbox: { kind: "local", cwd: workspaceDir },
      },
    },
  }
}

function centralVirtualSessionMeta(): ContentMeta {
  return {
    id: "surface-central",
    type: "session",
    scope: "directory",
    directory: "ws_authz",
    sessionId: "ses_authz",
    content: {
      type: "session",
      directory: "ws_authz",
      sessionId: "ses_authz",
      sessionRef: {
        sessionId: "ses_authz",
        host: "central",
        workspaceId: "ws_authz",
        toolSandbox: { kind: "virtual" },
      },
    },
  }
}
